import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

/** 复制模板后替换成你的真实业务工具。 */
export default function registerSubagentTools(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "project_note",
    label: "Project note",
    description: "把一条结构化项目备注返回给当前子 agent。",
    parameters: Type.Object({
      topic: Type.String({ description: "备注主题" }),
      detail: Type.String({ description: "备注内容" }),
    }),
    async execute(_toolCallId, params) {
      return {
        content: [{ type: "text", text: `[${params.topic}] ${params.detail}` }],
        details: { topic: params.topic },
      };
    },
  });
}
