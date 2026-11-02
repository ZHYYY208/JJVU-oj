const yaml = require('js-yaml');

// 各语言的 [时间倍率, 内存倍率]，未列出的语言为 1 倍
const RATES = {
    java: [2, 2],
    kt: [2, 2],
    py: [3, 2],
    'py.py3': [3, 2],
    'py.pypy3': [3, 2],
    js: [2, 2],
};

// 小内存限制下 JVM 默认按宿主机内存预分配，容易直接启动失败；
// 固定小初始堆 + SerialGC 后，堆按 cgroup 限制按需增长。
const JAVA_OPTS = '-Xms8m -Xmx4096m -XX:+UseSerialGC';

// 下拉里只展示这些语言（判题镜像实际安装了 gcc/g++、javac/java、python3、node、仓颉 cjc）
const VISIBLE = new Set(['c', 'cc', 'cc.cc11', 'cc.cc17', 'java', 'py.py3', 'cj']);

// 判题镜像未安装工具链的语言：隐藏并禁用，即使题目单独允许也拒绝提交
const MISSING = new Set(['pas', 'kt', 'kt.jvm', 'py.pypy3', 'php', 'rs', 'hs', 'go', 'rb', 'cs', 'r']);

const conf = yaml.load(SystemModel.get('hydrooj.langs'));
let changed = false;

// 仓颉（Cangjie）：判题镜像 /opt/cangjie 已装 SDK，编译器 cjc + 运行时库（沙箱里 /opt/cangjie 为只读挂载）
const CANGJIE = {
    compile: '/bin/bash -c "export CANGJIE_HOME=/opt/cangjie; export PATH=/opt/cangjie/bin:$PATH; export LD_LIBRARY_PATH=/opt/cangjie/tools/lib:/opt/cangjie/runtime/lib/linux_x86_64_cjnative; /opt/cangjie/bin/cjc foo.cj -o foo"',
    code_file: 'foo.cj',
    execute: '/bin/bash -c "export LD_LIBRARY_PATH=/opt/cangjie/runtime/lib/linux_x86_64_cjnative; ./foo"',
    display: 'Cangjie',
    highlight: 'clike',
    compile_time_limit: 60000,
    compile_memory_limit: 1024,
};
if (JSON.stringify(conf.cj) !== JSON.stringify(CANGJIE)) {
    conf.cj = CANGJIE;
    changed = true;
}

for (const lang in conf) {
    if (lang.startsWith('_')) continue;
    const entry = conf[lang];
    const hidden = !VISIBLE.has(lang);
    if (entry.hidden !== hidden) {
        entry.hidden = hidden;
        changed = true;
    }
    if (MISSING.has(lang) && entry.disabled !== true) {
        entry.disabled = true;
        changed = true;
    }
}

for (const lang in RATES) {
    const entry = conf[lang];
    if (!entry) continue;
    const [time, memory] = RATES[lang];
    if (entry.time_limit_rate === time && entry.memory_limit_rate === memory) continue;
    entry.time_limit_rate = time;
    entry.memory_limit_rate = memory;
    changed = true;
}

if (conf.java && !conf.java.execute.includes(JAVA_OPTS)) {
    conf.java.execute = conf.java.execute.replace('/usr/bin/java', `/usr/bin/java ${JAVA_OPTS}`);
    changed = true;
}

if (conf.py) {
    const compile = conf.py.compile.replace('/usr/bin/python ', '/usr/bin/python3 ');
    const execute = conf.py.execute.replace('/usr/bin/python ', '/usr/bin/python3 ');
    if (compile !== conf.py.compile || execute !== conf.py.execute) {
        conf.py.compile = compile;
        conf.py.execute = execute;
        changed = true;
    }
}

if (changed) await SystemModel.set('hydrooj.langs', yaml.dump(conf));
console.log('lang-config-ok', changed ? 'updated' : 'unchanged');
