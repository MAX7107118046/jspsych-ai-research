# CloudPsych 接入

独立包通过既有 `jspsych_plugin` 组件和 `CodeModule.v1` 接口接入 r205。当前模块导出器生成 0.3.0 构建产物，冻结依赖与缓存按版本标记。平台候选的既有验收记录见 verification.md；0.3 独立包验收见 verification-v0.3.md。

## 代码模块生成

```js
import { createCloudPsychCodeModule, attachCloudPsychCodeModule } from 'jspsych-ai-research/cloudpsych/module';

const artifact = await createCloudPsychCodeModule({
  mode: 'chat',
  interaction: frozenInteraction,
  parameters: { prompt: '请回答访谈问题', max_turns: 3 }
});
const builderProject = attachCloudPsychCodeModule(project, artifact, {
  stageId: 'main', routineId: 'interview'
});
```

将 builderProject 按编辑器现有导入接口保存。模块精确引用 `ai_research_chat@0.3.0`；主源码和样式从同一源码树构建，压缩冻结在模块中，保持在编辑器每模块 100000 字符限制以内。浏览器解压并加载一次，样式按版本添加。

实时模式使用现有 `CloudPsychAIRuntime`，由平台完成互动会话、模型连接和调用记录；固定材料模式可独立运行。interaction 对应工程现有 `AIInteractionSpec.v2`，其内容须与平台冻结协议一致。插件的 prompt 用于参与者呈现，平台实际系统指令由互动协议管理。

本次 DeepSeek/MiniMax 规则用于独立 HTTP transport 和通用代理。平台 transport 的端点、凭据与思考策略由平台连接管理，不能通过修改 trial 的独立 connection 设置来替代。升级已有平台工程时需发布新的锁定模块并验证平台连接规则。

## 浏览器适配

```js
import { createCloudPsychTrial } from 'jspsych-ai-research/cloudpsych';

const trial = createCloudPsychTrial({
  runtime: window.CloudPsychAIRuntime,
  interaction: frozenInteraction,
  context: () => projectVariables,
  on_finish: userCallback,
  platform_on_finish: collectPlatformData
}, { mode: 'interview', prompt: '访谈说明' });
```

上下文按 interaction.contextAllowlist 映射。每次逻辑请求提供请求 ID，正式模型与平台 turn/session 证据保存到调用结果 metadata。用户回调在平台回调前执行，异常记录后仍调用平台回调。

平台原有请求接口主要接收文本。多代理独立模型、媒体请求及其他扩展可显式注入对应 transport。作者配置保存为公开 trial 参数；平台自身的协议和主结果计分约束继续由平台验证。

## 版本与验收

插件包、模块版本、jsPsych 版本和数据格式分别管理。集成验证使用独立合成工程，覆盖配置 JSON 往返、完整实验、阶段、节点、Routine 编译、实际参与者运行和回调数据。作者页面、服务器保存回执和设备操作的验收证据分别记录在验证报告中。
