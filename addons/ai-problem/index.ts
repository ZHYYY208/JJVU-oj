import { existsSync, readFileSync } from 'fs';
import { extname, join } from 'path';
import {
    Context, Handler, PRIV, ProblemModel, StorageModel, SystemModel, Types, UserModel, post,
} from 'hydrooj';

const KEY_BASE_URL = 'ai-problem.baseUrl';
const KEY_API_KEY = 'ai-problem.apiKey';
const KEY_MODEL = 'ai-problem.model';

const SANDBOX_URL = process.env.AI_SANDBOX_URL || 'http://oj-judge:5050';
const MAX_INPUT_BYTES = 8 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
const GENERATION_DEADLINE_MS = 240 * 1000;

const DIFFICULTY_LABELS: Record<number, string> = {
    1: '入门',
    2: '简单',
    3: '中等',
    4: '困难',
};

interface AiConfig {
    baseUrl: string;
    apiKey: string;
    model: string;
}

interface GeneratedProblem {
    title: string;
    statement: string;
    tags: string[];
    difficulty: number;
    standardCode: string;
    generator: string;
    notes: string;
}

interface SandboxResult {
    status: string;
    exitStatus: number;
    time: number;
    memory: number;
    stdout: string;
    stderr: string;
    fileIds: Record<string, string>;
}

function getConfig(): AiConfig {
    return {
        baseUrl: SystemModel.get(KEY_BASE_URL) || process.env.AI_BASE_URL || 'https://api.deepseek.com/v1',
        apiKey: SystemModel.get(KEY_API_KEY) || process.env.AI_API_KEY || '',
        model: SystemModel.get(KEY_MODEL) || process.env.AI_MODEL || 'deepseek-chat',
    };
}

async function fetchWithTimeout(url: string, init: any, timeoutMs: number) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        return await fetch(url, { ...init, signal: controller.signal });
    } finally {
        clearTimeout(timer);
    }
}

function extractJson(text: string) {
    let body = text.trim();
    if (body.startsWith('```')) {
        body = body.replace(/^```[a-zA-Z]*\s*/, '').replace(/```\s*$/, '');
    }
    const start = body.indexOf('{');
    const end = body.lastIndexOf('}');
    if (start < 0 || end <= start) throw new Error('模型没有返回 JSON');
    return JSON.parse(body.slice(start, end + 1));
}

function clamp(value: number, min: number, max: number, fallback: number) {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, Math.round(n)));
}

async function callModel(config: AiConfig, prompt: string) {
    if (!config.apiKey) throw new Error('还没有配置模型 API Key，请先在右侧「模型配置」里填写');
    const url = `${config.baseUrl.replace(/\/+$/, '')}/chat/completions`;
    const payload: any = {
        model: config.model,
        messages: [
            {
                role: 'system',
                content: '你是一名严谨的算法竞赛与程序设计课程命题人。你只输出合法 JSON，不输出任何额外说明。',
            },
            { role: 'user', content: prompt },
        ],
        temperature: 0.3,
        max_tokens: 8192,
        response_format: { type: 'json_object' },
    };
    let res = await fetchWithTimeout(url, {
        method: 'POST',
        headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify(payload),
    }, 180000);
    if (!res.ok && res.status === 400) {
        delete payload.response_format;
        res = await fetchWithTimeout(url, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                authorization: `Bearer ${config.apiKey}`,
            },
            body: JSON.stringify(payload),
        }, 180000);
    }
    const text = await res.text();
    if (!res.ok) throw new Error(`模型接口返回 ${res.status}: ${text.slice(0, 300)}`);
    let data: any;
    try {
        data = JSON.parse(text);
    } catch (e) {
        throw new Error(`模型返回内容无法解析: ${text.slice(0, 200)}`);
    }
    const content = data.choices?.[0]?.message?.content;
    if (!content) throw new Error('模型返回内容为空，请检查模型名（建议使用 deepseek-chat）');
    return extractJson(content);
}

function buildPrompt(topic: string, difficulty: number, timeLimitMs: number, memoryLimitMb: number, testCount: number) {
    return `请为高校程序设计课程出一道在线评测题目，并给出可直接运行的标准程序和数据生成器。

题目要求 / 主题：
${topic}

难度：${DIFFICULTY_LABELS[difficulty] || '中等'}
时间限制：${timeLimitMs} ms
内存限制：${memoryLimitMb} MB
测试点数量：${testCount}（seed = 1 到 ${testCount}）

硬性要求：
1. 题面使用中文 Markdown，依次包含：题目描述、输入格式、输出格式、数据范围。样例部分必须原样使用下面两个占位符，我会用真实数据替换：
## 样例输入

\`\`\`text
{{SAMPLE_INPUT}}
\`\`\`

## 样例输出

\`\`\`text
{{SAMPLE_OUTPUT}}
\`\`\`
2. 标准程序使用 C++17，从标准输入读取、向标准输出写出，不能输出任何调试信息或提示语，且必须在限制内通过所有测试点。
3. 数据生成器使用 Python 3，从命令行参数 sys.argv[1] 读取整数 seed，先执行 random.seed(seed)，再向标准输出打印一组合法输入。
   seed=1 必须生成规模最小、适合放进题面的样例；其余 seed 要覆盖数据范围边界、特殊值（如 0、负数、重复元素）和一般随机数据。
4. 生成器不能依赖网络、第三方库或外部文件，单次运行不超过 10 秒。
5. 题面中的数据范围必须与生成器实际产生的数据一致。
6. 题目必须是标准输入/输出题，不要交互题、不要文件输入输出。

只输出一个 JSON 对象（不要 Markdown 代码围栏），字段如下：
{
  "title": "标题，不超过 30 个汉字",
  "statement": "完整的 Markdown 题面字符串，包含样例占位符",
  "tags": ["知识点标签", "2-4 个"],
  "difficulty": ${difficulty},
  "standardCode": "C++17 标准程序源码",
  "generator": "Python3 数据生成器源码",
  "notes": "一句话说明本题考点"
}`;
}

function normalizeGenerated(raw: any, fallbackDifficulty: number): GeneratedProblem {
    if (!raw || typeof raw !== 'object') throw new Error('模型返回结构不正确');
    const title = String(raw.title || '').trim().slice(0, 80);
    const statement = String(raw.statement || '').trim();
    const standardCode = String(raw.standardCode || '').trim();
    const generator = String(raw.generator || '').trim();
    if (!title) throw new Error('模型没有给出题目标题');
    if (statement.length < 30) throw new Error('模型给出的题面过短');
    if (!standardCode) throw new Error('模型没有给出标准程序');
    if (!generator) throw new Error('模型没有给出数据生成器');
    let tags: string[] = [];
    if (Array.isArray(raw.tags)) tags = raw.tags.map((i) => String(i).trim()).filter(Boolean);
    else if (typeof raw.tags === 'string') tags = raw.tags.split(/[,，、\s]+/).filter(Boolean);
    tags = Array.from(new Set(tags)).slice(0, 6).map((i) => i.slice(0, 24));
    return {
        title,
        statement: statement.slice(0, 30000),
        tags,
        difficulty: clamp(raw.difficulty, 1, 5, fallbackDifficulty),
        standardCode,
        generator,
        notes: String(raw.notes || '').slice(0, 300),
    };
}

async function callSandbox(body: any, timeoutMs = 90000): Promise<SandboxResult> {
    const res = await fetchWithTimeout(`${SANDBOX_URL}/run`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
    }, timeoutMs);
    if (!res.ok) throw new Error(`判题沙箱返回 ${res.status}`);
    const data: any = await res.json();
    const item = Array.isArray(data) ? data[0] : data;
    if (!item) throw new Error('判题沙箱返回空结果');
    return {
        status: item.status,
        exitStatus: item.exitStatus,
        time: item.time || 0,
        memory: item.memory || 0,
        stdout: item.files?.stdout || '',
        stderr: item.files?.stderr || '',
        fileIds: item.fileIds || {},
    };
}

async function sandboxDeleteFile(fileId: string) {
    try {
        await fetchWithTimeout(`${SANDBOX_URL}/file/${fileId}`, { method: 'DELETE' }, 5000);
    } catch (e) {
        // 清理失败不影响出题结果
    }
}

function describeSandboxError(result: SandboxResult, label: string) {
    const stderr = (result.stderr || '').trim().slice(0, 800);
    if (result.status === 'Time Limit Exceeded') return `${label}运行超时`;
    if (result.status === 'Memory Limit Exceeded') return `${label}内存超限`;
    if (result.status === 'Output Limit Exceeded') return `${label}输出超过限制`;
    return `${label}执行失败（${result.status}${stderr ? `：${stderr}` : ''}）`;
}

async function compileStandard(code: string) {
    const result = await callSandbox({
        cmd: [{
            args: ['/usr/bin/g++', '-O2', '-std=c++17', '-pipe', '-o', 'std', 'std.cpp'],
            env: ['PATH=/usr/bin:/bin', 'LANG=C.UTF-8'],
            files: [{ content: '' }, { name: 'stdout', max: 8192 }, { name: 'stderr', max: 65536 }],
            cpuLimit: 20000000000,
            clockLimit: 60000000000,
            memoryLimit: 1073741824,
            procLimit: 64,
            copyIn: { 'std.cpp': { content: code } },
            copyOut: ['stdout', 'stderr'],
            copyOutCached: ['std'],
        }],
    });
    if (result.status !== 'Accepted' || !result.fileIds.std) {
        throw new Error(`标准程序编译失败：${(result.stderr || '').trim().slice(0, 800)}`);
    }
    return result.fileIds.std;
}

async function runGenerator(code: string, seed: number) {
    const result = await callSandbox({
        cmd: [{
            args: ['/usr/bin/python3', 'gen.py', String(seed)],
            env: ['PATH=/usr/bin:/bin', 'LANG=C.UTF-8'],
            files: [{ content: '' }, { name: 'stdout', max: MAX_INPUT_BYTES }, { name: 'stderr', max: 65536 }],
            cpuLimit: 10000000000,
            clockLimit: 20000000000,
            memoryLimit: 536870912,
            procLimit: 64,
            copyIn: { 'gen.py': { content: code } },
            copyOut: ['stdout', 'stderr'],
        }],
    });
    if (result.status !== 'Accepted') throw new Error(`生成器 seed=${seed} ${describeSandboxError(result, '')}`);
    if (!result.stdout) throw new Error(`生成器 seed=${seed} 没有输出数据`);
    return result.stdout;
}

async function runStandard(stdFileId: string, input: string, timeLimitMs: number, memoryLimitMb: number) {
    const result = await callSandbox({
        cmd: [{
            args: ['/w/std'],
            env: ['PATH=/usr/bin:/bin'],
            files: [{ content: input }, { name: 'stdout', max: MAX_OUTPUT_BYTES }, { name: 'stderr', max: 65536 }],
            cpuLimit: Math.max(2000, timeLimitMs * 2) * 1000000,
            clockLimit: Math.max(5000, timeLimitMs * 4) * 1000000,
            memoryLimit: Math.max(128, memoryLimitMb * 2) * 1024 * 1024,
            procLimit: 64,
            copyIn: { std: { fileId: stdFileId } },
            copyOut: ['stdout', 'stderr'],
        }],
    });
    if (result.status !== 'Accepted') throw new Error(describeSandboxError(result, '标准程序'));
    return result.stdout;
}

function fillSamples(statement: string, sampleIn: string, sampleOut: string, warnings: string[]) {
    const hasIn = statement.includes('{{SAMPLE_INPUT}}');
    const hasOut = statement.includes('{{SAMPLE_OUTPUT}}');
    let content = statement;
    if (hasIn) content = content.split('{{SAMPLE_INPUT}}').join(sampleIn.trimEnd());
    else {
        content += `\n\n## 样例输入\n\n\`\`\`text\n${sampleIn.trimEnd()}\n\`\`\`\n`;
        warnings.push('模型题面缺少样例输入占位符，已自动追加。');
    }
    if (hasOut) content = content.split('{{SAMPLE_OUTPUT}}').join(sampleOut.trimEnd());
    else {
        content += `\n\n## 样例输出\n\n\`\`\`text\n${sampleOut.trimEnd()}\n\`\`\`\n`;
        warnings.push('模型题面缺少样例输出占位符，已自动追加。');
    }
    return content;
}

function maskConfig() {
    const config = getConfig();
    return {
        baseUrl: config.baseUrl,
        modelName: config.model,
        hasKey: !!config.apiKey,
    };
}

class AiProblemHandler extends Handler {
    async get() {
        this.response.template = 'ai_problem.html';
        this.response.body = {
            ...maskConfig(),
            genForm: { topic: '', difficulty: 3, tags: '', timeLimit: 1000, memoryLimit: 256, testCount: 10 },
            result: null,
        };
    }
}

class AiConfigHandler extends Handler {
    @post('baseUrl', Types.String)
    @post('model', Types.String)
    @post('apiKey', Types.Content, true)
    async post(domainId: string, baseUrl: string, model: string, apiKey = '') {
        await SystemModel.set(KEY_BASE_URL, baseUrl.trim() || 'https://api.deepseek.com/v1');
        await SystemModel.set(KEY_MODEL, model.trim() || 'deepseek-chat');
        if (apiKey.trim()) await SystemModel.set(KEY_API_KEY, apiKey.trim());
        this.response.redirect = this.url('ai_problem');
    }
}

class AiGenerateHandler extends Handler {
    @post('topic', Types.Content)
    @post('difficulty', Types.Int, true)
    @post('tags', Types.String, true)
    @post('timeLimit', Types.Int, true)
    @post('memoryLimit', Types.Int, true)
    @post('testCount', Types.Int, true)
    async post(
        domainId: string, topic: string, difficulty = 3, tags = '',
        timeLimit = 1000, memoryLimit = 256, testCount = 10,
    ) {
        await this.limitRate('ai_problem_generate', 600, 5);
        const genForm = {
            topic: (topic || '').trim(),
            difficulty: clamp(difficulty, 1, 4, 3),
            tags: (tags || '').trim(),
            timeLimit: clamp(timeLimit, 100, 10000, 1000),
            memoryLimit: clamp(memoryLimit, 32, 1024, 256),
            testCount: clamp(testCount, 3, 15, 10),
        };
        const log: string[] = [];
        const warnings: string[] = [];
        const started = Date.now();
        const deadline = started + GENERATION_DEADLINE_MS;
        const config = getConfig();
        const render = (result: any) => {
            this.response.template = 'ai_problem.html';
            this.response.body = { ...maskConfig(), genForm, result };
        };
        if (genForm.topic.length < 5) {
            render({ ok: false, message: '请至少写 5 个字描述题目主题或考点。' });
            return;
        }
        try {
            const versionRes = await fetchWithTimeout(`${SANDBOX_URL}/version`, {}, 8000);
            if (!versionRes.ok) throw new Error('判题沙箱不可用，请确认 oj-judge 容器已启动');
            log.push('判题沙箱连接正常');

            log.push(`调用模型 ${config.model} 生成题面与代码…`);
            const raw = await callModel(config, buildPrompt(
                genForm.topic, genForm.difficulty, genForm.timeLimit, genForm.memoryLimit, genForm.testCount,
            ));
            if (Date.now() > deadline) throw new Error('生成超时，请减少测试点后重试');
            const generated = normalizeGenerated(raw, genForm.difficulty);
            log.push(`题面已生成：《${generated.title}》`);

            log.push('编译标准程序…');
            const stdFileId = await compileStandard(generated.standardCode);
            log.push('标准程序编译通过');

            const inputs: string[] = [];
            const outputs: string[] = [];
            try {
                for (let seed = 1; seed <= genForm.testCount; seed += 1) {
                    if (Date.now() > deadline) throw new Error('生成测试数据超时，请减少测试点后重试');
                    const input = await runGenerator(generated.generator, seed);
                    if (Buffer.byteLength(input) > MAX_INPUT_BYTES) throw new Error(`seed=${seed} 生成的数据超过 8MB`);
                    const output = await runStandard(stdFileId, input, genForm.timeLimit, genForm.memoryLimit);
                    inputs.push(input);
                    outputs.push(output);
                    log.push(`测试点 ${seed}/${genForm.testCount} 完成（输入 ${(Buffer.byteLength(input) / 1024).toFixed(1)} KB）`);
                }
            } finally {
                await sandboxDeleteFile(stdFileId);
            }

            const statement = fillSamples(generated.statement, inputs[0], outputs[0], warnings);
            const finalTags = genForm.tags
                ? genForm.tags.split(/[,，、\s]+/).filter(Boolean).slice(0, 6)
                : generated.tags;

            log.push('写入题库…');
            const docId = await ProblemModel.add(
                domainId, '', generated.title, statement, this.user._id,
                finalTags, { difficulty: generated.difficulty, hidden: false },
            ) as number;
            const configYaml = `time: ${genForm.timeLimit}ms\nmemory: ${genForm.memoryLimit}m\n`;
            await ProblemModel.edit(domainId, docId, { config: configYaml });
            await ProblemModel.addTestdata(domainId, docId, 'config.yaml', Buffer.from(configYaml));
            for (let i = 0; i < inputs.length; i += 1) {
                await ProblemModel.addTestdata(domainId, docId, `${i + 1}.in`, Buffer.from(inputs[i]));
                await ProblemModel.addTestdata(domainId, docId, `${i + 1}.out`, Buffer.from(outputs[i]));
            }
            log.push(`题目已创建：#${docId}`);

            render({
                ok: true,
                pid: docId,
                title: generated.title,
                notes: generated.notes,
                tags: finalTags,
                difficulty: generated.difficulty,
                testCount: inputs.length,
                sampleIn: inputs[0].trimEnd().slice(0, 2000),
                sampleOut: outputs[0].trimEnd().slice(0, 2000),
                warnings,
                log,
                elapsed: ((Date.now() - started) / 1000).toFixed(1),
            });
        } catch (e: any) {
            log.push(`失败：${e?.message || e}`);
            let message = e?.message || String(e);
            if (e?.name === 'AbortError') message = '模型请求超时（180 秒），请重试或换一个模型';
            render({ ok: false, message, log });
        }
    }
}

const LOGO_PATHS = [
    join(__dirname, 'assets', 'logo.png'),
    '/root/.hydro/addons/ai-problem/assets/logo.png',
];

let logoPng: Buffer | null | undefined;

function readLogoPng() {
    if (logoPng !== undefined) return logoPng;
    for (const file of LOGO_PATHS) {
        try {
            if (existsSync(file)) {
                logoPng = readFileSync(file);
                return logoPng;
            }
        } catch (e) {
            // try next candidate
        }
    }
    logoPng = null;
    return logoPng;
}

const AVATAR_PATHS = [
    join(__dirname, 'assets', 'avatar.jpg'),
    '/root/.hydro/addons/ai-problem/assets/avatar.jpg',
];

let avatarJpg: Buffer | null | undefined;

function readAvatarJpg() {
    if (avatarJpg !== undefined) return avatarJpg;
    for (const file of AVATAR_PATHS) {
        try {
            if (existsSync(file)) {
                avatarJpg = readFileSync(file);
                return avatarJpg;
            }
        } catch (e) {
            // try next candidate
        }
    }
    avatarJpg = null;
    return avatarJpg;
}

class JjyuojAvatarHandler extends Handler {
    noCheckPermView = true;

    async get() {
        const jpg = readAvatarJpg();
        if (jpg) {
            this.response.type = 'image/jpeg';
            this.response.addHeader('Cache-Control', 'public, max-age=86400');
            this.response.body = jpg;
            return;
        }
        this.response.status = 404;
        this.response.body = '';
    }
}

// 本地默认头像：所有 Gravatar 请求都重定向到本站此路由，不访问任何外网
class JjyuojDefaultAvatarHandler extends Handler {
    noCheckPermView = true;

    async get() {
        this.response.type = 'image/svg+xml';
        this.response.addHeader('Cache-Control', 'public, max-age=86400');
        this.response.body = `<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128">
  <circle cx="64" cy="64" r="64" fill="#e2e8f0"/>
  <circle cx="64" cy="50" r="22" fill="#94a3b8"/>
  <path d="M64 78c-24 0-40 14-40 30v6h80v-6c0-16-16-30-40-30z" fill="#94a3b8"/>
</svg>`;
    }
}

class JjyuojLogoHandler extends Handler {
    noCheckPermView = true;

    async get() {
        const png = readLogoPng();
        if (png) {
            this.response.type = 'image/png';
            this.response.addHeader('Cache-Control', 'public, max-age=3600');
            this.response.body = png;
            return;
        }
        this.response.type = 'image/svg+xml';
        this.response.body = `<svg xmlns="http://www.w3.org/2000/svg" width="220" height="48" viewBox="0 0 220 48">
  <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stop-color="#3b82f6"/><stop offset="1" stop-color="#8b5cf6"/>
  </linearGradient></defs>
  <rect x="2" y="6" width="36" height="36" rx="9" fill="url(#g)"/>
  <path d="M15 16h12v13a5 5 0 0 1-5 5h-3" fill="none" stroke="#fff" stroke-width="3.2" stroke-linecap="round"/>
  <text x="48" y="34" font-family="Segoe UI, PingFang SC, sans-serif" font-size="23" font-weight="700" fill="#111827">JJVU</text>
  <text x="132" y="34" font-family="Segoe UI, PingFang SC, sans-serif" font-size="23" font-weight="700" fill="#3b82f6">oj</text>
</svg>`;
    }
}

const AVATAR_MAX_BYTES = 2 * 1024 * 1024;
const BACKGROUND_MAX_BYTES = 5 * 1024 * 1024;
const AVATAR_EXTS = ['.jpg', '.jpeg', '.png'];
const BACKGROUND_EXTS = ['.jpg', '.jpeg', '.png', '.webp'];

function uploadError(handler: Handler, message: string) {
    handler.response.status = 400;
    handler.response.body = { ok: false, error: message };
}

// 头像 / 个性化背景上传：一律存到本站文件存储（data/file），不访问外网，并限制大小
class JjyuojAvatarUploadHandler extends Handler {
    noCheckPermView = true;

    async post() {
        const file = this.request.files?.file;
        if (!file) return uploadError(this, '请选择要上传的图片');
        if (file.size > AVATAR_MAX_BYTES) return uploadError(this, '头像大小不能超过 2MB');
        const ext = extname(file.originalFilename || file.name || '').toLowerCase();
        if (!AVATAR_EXTS.includes(ext)) return uploadError(this, '头像仅支持 JPG / PNG 格式');
        await StorageModel.put(`user/${this.user._id}/.avatar${ext}`, file.filepath, this.user._id);
        await UserModel.setById(this.user._id, { avatar: `url:/file/${this.user._id}/.avatar${ext}` });
        this.response.body = { ok: true, url: `/file/${this.user._id}/.avatar${ext}` };
    }
}

class JjyuojBackgroundUploadHandler extends Handler {
    noCheckPermView = true;

    async post() {
        const file = this.request.files?.file;
        if (!file) return uploadError(this, '请选择要上传的图片');
        if (file.size > BACKGROUND_MAX_BYTES) return uploadError(this, '背景图大小不能超过 5MB');
        const ext = extname(file.originalFilename || file.name || '').toLowerCase();
        if (!BACKGROUND_EXTS.includes(ext)) return uploadError(this, '背景图仅支持 JPG / PNG / WebP 格式');
        await StorageModel.put(`user/${this.user._id}/.background${ext}`, file.filepath, this.user._id);
        await UserModel.setById(this.user._id, { backgroundImage: `/file/${this.user._id}/.background${ext}` });
        this.response.body = { ok: true, url: `/file/${this.user._id}/.background${ext}` };
    }
}

// FPS/LibreOJ 导入的题面会带预渲染 KaTeX：<span class="katex"><span class="katex-mathml">MathML文本 LaTeX源码 </span><span class="katex-html">…</span></span>
// Hydro 渲染时会经过 XSS 白名单，katex 相关 class 被剥掉后 mathml 里的原始 LaTeX 源码就显示成乱码。
// 这里在题目写入前把预渲染块还原成 \(…\) / \[…\] 源码，交给 Hydro 自己的 KaTeX 重新渲染。
// katex-mathml 里是「渲染后的 MathML 文本 + LaTeX 源码」，katex-html 里是同一份渲染文本（含零宽空格）。
// 用 katex-html 的可视文本做前缀，从 mathml 文本里剥掉它，剩下的就是 LaTeX 源码；前缀对不上（分式/求和打乱顺序、根号隐式等）时按可视文本长度回退。
function stripTags(s: string) {
    return s.replace(/<[^>]*>/g, '');
}

function decodeEntities(s: string) {
    return s
        .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
        .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&');
}

function stripZwsp(s: string) {
    return s.split('\u200b').join('');
}

function escapeLatex(src: string) {
    return src.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function extractKatexLatex(block: string): string | null {
    const mathml = block.match(/<span class="katex-mathml">([\s\S]*?)<\/span>/);
    if (!mathml) return null;
    const htmlSpan = block.match(/<span class="katex-html"[^>]*>([\s\S]*)$/);
    const mathmlText = stripZwsp(decodeEntities(stripTags(mathml[1])));
    const visualText = htmlSpan ? stripZwsp(decodeEntities(stripTags(htmlSpan[1]))) : '';
    let latex: string;
    if (visualText.length > 0 && mathmlText.startsWith(visualText)) {
        latex = mathmlText.slice(visualText.length);
    } else {
        const bs = mathmlText.indexOf('\\');
        if (bs === -1) return null;
        // 对齐环境（aligned/array 等）会按列重排，MathML 与可视文本长度不一致，直接用第一个反斜杠（源码必然以 \begin 开头）。
        if (/\\begin\{/.test(mathmlText)) {
            latex = mathmlText.slice(bs);
        } else {
            // 分式/求和等只会打乱顺序、不改变字符数；MathML 文本长度 ≈ 可视文本长度，只差根号（√ 在可视里显式出现、在 MathML 里是隐式的）。
            const radicals = (visualText.match(/\u221a/g) || []).length;
            const b = visualText.length - radicals;
            if (b <= 0 || b >= mathmlText.length) latex = mathmlText.slice(bs);
            else {
                const candidate = mathmlText.slice(b);
                latex = candidate.includes('\\') ? candidate : mathmlText.slice(bs);
            }
        }
    }
    latex = latex.trim();
    return latex || null;
}

function cleanFpsMath(html: string) {
    const s = String(html || '');
    if (s.indexOf('<span class="katex">') === -1) return s;
    const OPEN = '<span class="katex">';
    const DISPLAY = '<span class="katex-display">';
    let out = '';
    let pos = 0;
    while (true) {
        const start = s.indexOf(OPEN, pos);
        if (start === -1) { out += s.slice(pos); break; }
        const isDisplay = start >= DISPLAY.length && s.slice(start - DISPLAY.length, start) === DISPLAY;
        const blockStart = isDisplay ? start - DISPLAY.length : start;
        out += s.slice(pos, blockStart);
        let depth = 1;
        let i = start + OPEN.length;
        while (i < s.length && depth > 0) {
            const open = s.indexOf('<span', i);
            const close = s.indexOf('</span>', i);
            if (close === -1) break;
            if (open !== -1 && open < close) { depth++; i = open + 5; }
            else { depth--; i = close + 7; }
        }
        if (depth !== 0) {
            // 残缺的 katex 块（源数据截断导致 span 不配对），保持原样避免误伤
            out += s.slice(blockStart, start + OPEN.length);
            pos = start + OPEN.length;
            continue;
        }
        let blockEnd = i;
        if (isDisplay && s.slice(blockEnd, blockEnd + 7) === '</span>') blockEnd += 7;
        const block = s.slice(blockStart, blockEnd);
        const latex = extractKatexLatex(block);
        if (latex === null) out += block;
        else out += (isDisplay ? '\\[' : '\\(') + escapeLatex(latex) + (isDisplay ? '\\]' : '\\)');
        pos = blockEnd;
    }
    return out;
}

export async function apply(ctx: Context) {
    ctx.on('problem/before-edit', ($set) => {
        if (typeof $set.content === 'string' && $set.content.includes('<span class="katex">')) {
            $set.content = cleanFpsMath($set.content);
        }
    });
    ctx.on('problem/add', async (doc, docId) => {
        const original = typeof doc.content === 'string' ? doc.content : '';
        const cleaned = cleanFpsMath(original);
        if (cleaned === original) return;
        try {
            await ProblemModel.edit(doc.domainId, docId, { content: cleaned });
        } catch (e: any) {
            console.error('[ai-problem] clean FPS math failed for #%d: %s', docId, e?.message || e);
        }
    });

    ctx.injectUI('Nav', 'ai_problem', { prefix: 'ai-problem', displayName: 'AI 出题' }, PRIV.PRIV_EDIT_SYSTEM);
    ctx.Route('ai_problem', '/ai-problem', AiProblemHandler, PRIV.PRIV_EDIT_SYSTEM);
    ctx.Route('ai_problem_generate', '/ai-problem/generate', AiGenerateHandler, PRIV.PRIV_EDIT_SYSTEM);
    ctx.Route('ai_problem_config', '/ai-problem/config', AiConfigHandler, PRIV.PRIV_EDIT_SYSTEM);
    ctx.Route('jjyuoj_logo_png', '/jjyuoj-logo.png', JjyuojLogoHandler);
    ctx.Route('jjyuoj_logo_svg', '/jjyuoj-logo.svg', JjyuojLogoHandler);
    ctx.Route('jjyuoj_favicon', '/favicon.ico', JjyuojLogoHandler);
    ctx.Route('jjyuoj_avatar', '/jjyuoj-avatar.jpg', JjyuojAvatarHandler);
    ctx.Route('jjyuoj_default_avatar', '/jjyuoj-avatar/:hash', JjyuojDefaultAvatarHandler);
    ctx.Route('jjyuoj_avatar_upload', '/home/avatar-upload', JjyuojAvatarUploadHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('jjyuoj_background_upload', '/home/background-upload', JjyuojBackgroundUploadHandler, PRIV.PRIV_USER_PROFILE);
}
