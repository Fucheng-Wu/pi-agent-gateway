import { join } from "node:path";
import {
  getAgentDir,
  ModelRegistry,
  ModelRuntime,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";

export interface SharedResources {
  modelRuntime: ModelRuntime;
  modelRegistry: ModelRegistry;
  settingsManager: SettingsManager;
  agentDir: string;
  cwd: string;
}

export async function createSharedResources(cwd: string): Promise<SharedResources> {
  const agentDir = process.env.PI_AGENT_DIR || getAgentDir();
  const modelRuntime = await ModelRuntime.create({
    authPath: join(agentDir, "auth.json"),
    modelsPath: join(agentDir, "models.json"),
  });
  const modelRegistry = new ModelRegistry(modelRuntime);
  const settingsManager = SettingsManager.create(cwd, agentDir);
  return { modelRuntime, modelRegistry, settingsManager, agentDir, cwd };
}
