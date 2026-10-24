import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  getAgentDir,
  ModelRegistry,
  ModelRuntime,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { FeatureManager } from "./feature-manager.js";
import { PermissionBroker } from "./permissions.js";
import { PrimaryAgentRegistry } from "./primary-agents.js";

export interface SharedResources {
  modelRuntime: ModelRuntime;
  modelRegistry: ModelRegistry;
  settingsManager: SettingsManager;
  features: FeatureManager;
  agentDir: string;
  cwd: string;
  backendDir: string;
  permissions: PermissionBroker;
  primaryAgents: PrimaryAgentRegistry;
}

export async function createSharedResources(cwd: string): Promise<SharedResources> {
  const backendDir = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const agentDir = process.env.PI_AGENT_DIR || getAgentDir();
  const modelRuntime = await ModelRuntime.create({
    authPath: join(agentDir, "auth.json"),
    modelsPath: join(agentDir, "models.json"),
  });
  const modelRegistry = new ModelRegistry(modelRuntime);
  const settingsManager = SettingsManager.create(cwd, agentDir);
  const permissions = new PermissionBroker();
  const primaryAgents = new PrimaryAgentRegistry(backendDir, agentDir);
  const features = new FeatureManager(cwd, agentDir, settingsManager, modelRuntime, backendDir, permissions, primaryAgents);
  return { modelRuntime, modelRegistry, settingsManager, features, agentDir, cwd, backendDir, permissions, primaryAgents };
}
