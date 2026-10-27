const domainId = 'jjyu';
const uid = 1;

async function upsertProblem(pid, title, content, tags, difficulty, tests) {
  const exists = await ProblemModel.get(domainId, pid, ['docId'], true);
  const docId = exists ? exists.docId : await ProblemModel.add(domainId, pid, title, content, uid, tags, { difficulty });
  for (const [name, data] of tests) {
    await ProblemModel.addTestdata(domainId, docId, name, Buffer.from(data));
  }
  return docId;
}

const abContent = `# A+B Problem

输入两个整数 a 和 b，输出它们的和。

## 输入格式

一行两个整数 a, b（-10^9 ≤ a, b ≤ 10^9），用空格分隔。

## 输出格式

一个整数，表示 a + b 的值。

## 样例输入

\`\`\`text
1 2
\`\`\`

## 样例输出

\`\`\`text
3
\`\`\`

## 数据范围

- 对于 100% 的数据，|a|, |b| ≤ 10^9。`;

const sumContent = `# 求和

输入一个正整数 n，输出 1 + 2 + … + n 的值。

## 输入格式

一行一个正整数 n（1 ≤ n ≤ 10^9）。

## 输出格式

一个整数，表示 1 到 n 的和。

## 样例输入

\`\`\`text
10
\`\`\`

## 样例输出

\`\`\`text
55
\`\`\`

## 提示

结果可能超过 32 位整数范围，请使用 64 位整数。`;

const d1 = await upsertProblem('P1001', 'A+B Problem', abContent, ['入门', '模拟'], 1, [
  ['config.yaml', 'time: 1000ms\nmemory: 256m\n'],
  ['1.in', '1 2\n'], ['1.out', '3\n'],
  ['2.in', '100 200\n'], ['2.out', '300\n'],
  ['3.in', '-5 5\n'], ['3.out', '0\n'],
  ['4.in', '1000000000 1000000000\n'], ['4.out', '2000000000\n'],
]);

const d2 = await upsertProblem('P1002', '求和', sumContent, ['入门', '数学'], 2, [
  ['config.yaml', 'time: 1000ms\nmemory: 256m\n'],
  ['1.in', '10\n'], ['1.out', '55\n'],
  ['2.in', '1\n'], ['2.out', '1\n'],
  ['3.in', '1000000\n'], ['3.out', '500000500000\n'],
]);

const now = Date.now();

async function upsertContest(title, content, rule, beginAt, endAt, pids, extra) {
  const list = await ContestModel.getMulti(domainId, { title }).toArray();
  if (list.length) {
    await ContestModel.edit(domainId, list[0].docId, { content, rule, beginAt, endAt, pids, ...extra });
    return list[0].docId;
  }
  return await ContestModel.add(domainId, title, content, uid, rule, beginAt, endAt, pids, false, extra);
}

const tid = await upsertContest(
  'JJVUoj 示例比赛',
  '## 比赛说明\n\n这是 JJVUoj 的示例比赛，用于演示比赛功能。\n\n- 共 2 道题，按通过题数排名，同题数按罚时。\n- 比赛期间可以多次提交，以最后一次通过为准。',
  'acm',
  new Date(now - 3600 * 1000), new Date(now + 7 * 24 * 3600 * 1000),
  [d1, d2],
);

const hid = await upsertContest(
  '第一次课后作业（示例）',
  '## 作业说明\n\n这是 JJVUoj 的示例作业（Assignment）。\n\n- 完成后点击提交，系统会自动评测。\n- 截止前可以反复提交。',
  'homework',
  new Date(now), new Date(now + 30 * 24 * 3600 * 1000),
  [d1],
  { penaltySince: new Date(now), penaltyRules: { '1': 100 }, assign: [] },
);

const homeContent = require('fs').readFileSync('/root/seed/home.md', 'utf8');
await DomainModel.edit('system', { bulletin: homeContent });
await DomainModel.edit(domainId, { bulletin: homeContent, _join: { method: 1, role: 'default' } });

console.log('seed-ok', JSON.stringify({ problems: [d1, d2], contests: [tid, hid] }));
