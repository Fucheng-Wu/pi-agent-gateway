import { join } from "node:path";
import {
  AuthStorage,
  getAgentDir,
  ModelRegistry,
  SettingsManager,
} from "@mariozechner/pi-coding-agent";

/** Pi 0.73 exposes these two services instead of the newer ModelRuntime API. */
export interface SharedResources {
  authStorage: AuthStorage;
  modelRegistry: ModelRegistry;
  settingsManager: SettingsManager;
  agentDir: string;
  cwd: string;
}

export function createSharedResources(cwd: string): SharedResources {
  const agentDir = process.env.PI_AGENT_DIR || getAgentDir();
  const authStorage = AuthStorage.create(join(agentDir, "auth.json"));
  const modelRegistry = ModelRegistry.create(authStorage, join(agentDir, "models.json"));
  const settingsManager = SettingsManager.create(cwd, agentDir);
  return { authStorage, modelRegistry, settingsManager, agentDir, cwd };
}
