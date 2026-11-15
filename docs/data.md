# 数据与现有口径

demand 为服务分钟；同一 scenario 的 weight 必须一致，不能按服务点重复归一。

`data/records.json` 是版本为 1 的演练数据，所有人员、机构、商品和交易均为本地合成记录。`id` 是导入记录键，不自动代表企业、访问或其他统计单位；记录键不得重复。数值字段必须有限，整数字段不得超过安全整数范围。空字符串可用于字段约定允许的未公开标签，不用零冒充缺测。

| 字段 | 类型 |
| --- | --- |
| `id` | `string` |
| `scenario` | `string` |
| `point` | `string` |
| `demand` | `number` |
| `weight` | `number` |
| `language` | `string` |

现有 `summary` 按 `point` 清点记录，`sum` 为 `demand` 的逐行核对值，不代表统计推断或跨期业务指标。分组按键排序，行按记录键稳定处理。`data/expected-summary.json` 是独立生成的现有核算对照；`data/policy.json` 保存业务配置的演练值。

`inspect` 返回输入行数、字段列表与 SHA-256 指纹；指纹不依赖字段或记录排列。数据版本不支持时应直接拒绝，不做静默迁移。错误发生时命令返回非零退出码。

## 联合情景

容量建议按 `scenario` 整行读取记录：同一 `scenario` 下每个 `point` 必须恰好有一行需求，且同一基准下所有 `point` 都出现在每个 `scenario` 中。缺行、同一 `scenario` 权重不一致或同一 `scenario`+`point` 重复都会直接拒绝，避免把各服务点的分位数拼成从未发生的世界。`point` 的语言在各情景间必须一致。

## 业务配置（`data/policy.json`）

| 字段 | 说明 |
| --- | --- |
| `budget` | 可派人员数上限，非负整数 |
| `minutesPerWorker` | 每名当班人员在一个情景内可提供的服务分钟 |
| `alpha` | CVaR 置信水平，`0 <= alpha < 1` |
| `riskWeight` | 风险厌恶目标中 CVaR 的权重，非负 |
| `weightSemantics` | `weights`（默认）或 `probabilities` |
| `minimum` | 服务点到最低在岗人数，非负整数 |
| `transferCost` | 服务点到跨点调动成本，单位为服务分钟；不得大于等于 `minutesPerWorker` |
| `workers[].id` | 人员唯一键 |
| `workers[].languages` | 该人员可服务的语言 |
| `workers[].points` | 该人员可被派往的服务点 |
| `workers[].home` | 可选，所属服务点；派往其他点需扣 `transferCost` |
| `workers[].available` | 可选，班次可用性，默认 `true`；为 `false` 时不可派出 |

人员只能被派往其 `points` 内的服务点，且该服务点的语言必须在其 `languages` 内；不能拆出半个人。每名人员在同一情景至多服务一个服务点，空出来的预算不会自动转化为其他资源。

## 容量口径

服务点 `p` 在情景 `s` 的可用分钟为派往该点人员的有效分钟之和，有效分钟为 `minutesPerWorker` 减去（派往非 `home` 点时的）`transferCost`。情景缺口为各服务点 `max(0, demand - 可用分钟)` 之和。

目标为 `加权平均缺口 + riskWeight × CVaR(alpha)`。CVaR 按离散情景的损失从大到小累计到 `1 - alpha`；若边界落在某个情景（或同值组）内部，只计入跨越边界所需的那部分权重，同值组内按各情景权重比例分摊。零权重情景不进入尾部。

情景权重只有在配置显式声明 `weightSemantics: "probabilities"` 时才作概率解释；否则 `capacity` 输出说明权重是规划权重，并拒绝概率化风险解释。

## 最优性与搜索界限

候选分配数为每人 `(可派点数 + 1)` 的乘积。不超过 `exhaustiveLimit`（默认 100000）时完整枚举，`optimality` 为 `global-optimum`；超过时使用分支定界。分支定界完整结束且未触及节点/时限时同样是 `global-optimum`；被截断时只报告 `bounded-search`、`lowerBound`、`upperBound`、`gap` 与截断原因，不宣称全局最优，也不把“未找到可行解”当成不可行证明。

`infeasibilityConflicts` 只在完整搜索证明不可行后，报告最小组的约束冲突：`budget-vs-minimum`、`minimum-vs-eligibility`（可派人员或班次可用性不足），或无法归入上述最小冲突组的 `combined-constraints`。
