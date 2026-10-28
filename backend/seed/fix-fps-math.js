// 一次性修复：把 FPS/LibreOJ 导入题面还原干净（幂等，可重复执行）
// 1) 剥掉 LibreOJ 页面外壳（开头/结尾的多余 div 包装）
// 2) 把预渲染 KaTeX 还原成 Hydro 的 \(…\) / \[…\] 源码
// katex-mathml 里是「渲染后的 MathML 文本 + LaTeX 源码」，katex-html 里是同一份渲染文本（含零宽空格）。
// 用 katex-html 的可视文本做前缀剥出 LaTeX；前缀对不上（分式/求和打乱顺序、根号隐式等）时按长度/根号数回退。
function stripTags(s) {
  return s.replace(/<[^>]*>/g, '');
}
function decodeEntities(s) {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (m, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (m, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}
function stripZwsp(s) {
  return s.split('\u200b').join('');
}
function escapeLatex(src) {
  return src.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function extractKatexLatex(block) {
  const mathml = block.match(/<span class="katex-mathml">([\s\S]*?)<\/span>/);
  if (!mathml) return null;
  const htmlSpan = block.match(/<span class="katex-html"[^>]*>([\s\S]*)$/);
  const mathmlText = stripZwsp(decodeEntities(stripTags(mathml[1])));
  const visualText = htmlSpan ? stripZwsp(decodeEntities(stripTags(htmlSpan[1]))) : '';
  let latex;
  if (visualText.length > 0 && mathmlText.startsWith(visualText)) {
    latex = mathmlText.slice(visualText.length);
  } else {
    const bs = mathmlText.indexOf('\\');
    if (bs === -1) return null;
    if (/\\begin\{/.test(mathmlText)) {
      latex = mathmlText.slice(bs);
    } else {
      const radicals = (visualText.match(/\u221a/g) || []).length;
      const b = visualText.length - radicals;
      if (b <= 0 || b >= mathmlText.length) {
        latex = mathmlText.slice(bs);
      } else {
        const candidate = mathmlText.slice(b);
        latex = candidate.includes('\\') ? candidate : mathmlText.slice(bs);
      }
    }
  }
  latex = latex.trim();
  return latex || null;
}
function cleanFpsMath(html) {
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
// 剥掉 LibreOJ 页面外壳：每个 section 的包裹开头 + section 之间的页面外壳（</div></div></div></div><div class="row"><div class="column">）
const FPS_WRAPPER_OPEN = '<div class="ui bottom attached segment font-content"><div style="position: relative; overflow: hidden; ">';
const FPS_BOUNDARY = /<\/div><\/div>\s*<\/div>\s*<\/div>\s*<div class="row">\s*<div class="column">\s*/g;
function stripFpsWrapper(html) {
  const s = String(html || '');
  if (!s.startsWith(FPS_WRAPPER_OPEN)) return s;
  return s.split(FPS_WRAPPER_OPEN).join('').replace(FPS_BOUNDARY, '\n');
}
function cleanFpsContent(html) {
  return cleanFpsMath(stripFpsWrapper(html));
}

const docs = await ProblemModel.getMulti('system', {}, ['docId', 'content']).toArray();
let fixed = 0;
for (const d of docs) {
  const c = typeof d.content === 'string' ? d.content : '';
  const next = cleanFpsContent(c);
  if (next !== c) {
    await ProblemModel.edit('system', d.docId, { content: next });
    fixed++;
  }
}
console.log('已修复', fixed, '道题的公式乱码');
