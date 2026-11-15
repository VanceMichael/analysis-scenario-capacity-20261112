# scenario-capacity

demand 为服务分钟；同一 scenario 的 weight 必须一致，不能按服务点重复归一。

项目提供本地记录校验、输入指纹、按 `point` 的原始核算，以及在给定联合情景和本地业务配置下的整数容量建议。分析人员可以保留完整输入并复查每次导出的 JSON；原始数据不被命令改写。业务配置位于 `data/policy.json`，字段约定在 `docs/data.md`。

容量建议读取已经给定的联合情景：同一 `scenario` 下多个服务点的需求是同一个世界，不会把各服务点的分位数分别拼成“从未发生的世界”。人员在固定预算下按整数分配到服务点，目标显式包含加权平均缺口和指定置信水平的 CVaR；被搜索界限截断的方案只会标为 `bounded-search`，不会标成全局最优。

## 运行

使用 Node.js 22 LTS（>=22.22.1 且 <23）和 npm，无第三方运行依赖。
`.nvmrc` 选择 22 主版本，清单与锁文件记录相同的兼容范围；Dockerfile 仍固定基础镜像摘要，容器构建可精确复现。

```sh
npm ci --ignore-scripts --no-audit --no-fund --offline
npm run build
npm test
npm run summary
npm run capacity
node src/cli.js inspect --input data/records.json
node src/cli.js summary --input data/records.json --out var/summary.json
node src/cli.js capacity --policy data/policy.json --out var/capacity.json
npm run demo
```

`capacity` 只读取 `--input` 指向的本地情景和 `--policy` 指向的本地配置。`--budget` 可以覆盖配置中的预算（非负整数），不会改变情景或人员数据；`--require-probability` 要求权重已在配置中声明为预测概率，否则命令以非零退出码拒绝概率化风险解释。

`npm run demo` 在本地打印输入、现有核算、业务配置和容量建议，并生成 `var/summary.json` 与 `var/capacity.json`，不访问网络、不等待真实业务时间，通常几秒内完成。输出目录可删除后重新运行，测试只使用临时目录。

## 容量建议输出

`capacity` 的输出包含：

- `averageOptimal`：只最小化加权平均缺口（同值时取较小 CVaR）的方案；
- `riskAverse`：最小化 `期望缺口 + riskWeight × CVaR(alpha)` 的方案；
- `comparison`：两方案的人员调整、各情景缺口变化，以及同一风险目标下的差值；
- `marginalWorker`：预算加一名人员后的方案、改善的情景与每个服务点的平均缺口变化；
- `scenarios[].perPoint`：每个情景每个服务点的需求、可用分钟与缺口；
- `tail`：CVaR 的尾部成员；跨过 `1 - alpha` 分位边界的离散情景会带 `inclusionFraction` 部分权重，同值尾部按权重比例分摊边界份额；
- `search`：`exhaustive-enumeration` 或 `branch-and-bound`、`status`、`optimality`、上下界与 `gap`；
- `conflicts`：不可行时只报告最小组的约束冲突（预算对最低保障、最低保障对可派人员等）；
- `feasibility`：`feasible`、`infeasible` 或被截断的 `undetermined`。

情景权重默认是规划权重，不是预测概率；未在配置中声明 `weightSemantics: "probabilities"` 时，输出明确拒绝概率化风险解释，CVaR 只作为离散情景的加权尾部平均。

## 容器

```sh
docker build -t scenario-capacity:local .
docker run --rm --network none scenario-capacity:local
```

Dockerfile 固定 Node.js 基础镜像摘要，构建时执行语法检查和测试。镜像构建完成后演示无需联网；可覆盖命令运行 `npm test`。构建不需要真实账号、邮件服务、数据库或线上数据。

## 目录

- `src/dataset.js`：记录校验、规范序列化和数据指纹。
- `src/domain.js`：当前业务分组核算。
- `src/risk.js`：离散情景权重、加权平均、CVaR 与尾部边界处理。
- `src/policy.js`：本地业务配置校验。
- `src/capacity.js`：联合情景、整数分配、目标搜索与约束诊断。
- `src/cli.js`：本地读取、检查和导出入口。
- `src/output.js`：以临时文件写入后替换完整 JSON。
- `test/`：输入约束、领域核对、风险数值、容量核验、命令与输出回归。
- `data/`：合成记录、独立核对值及本地业务配置。
