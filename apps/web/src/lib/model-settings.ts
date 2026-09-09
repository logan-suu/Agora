export interface AgentModelView {
  role: string;
  status: string;
  model: string;
  connectionId?: string;
  baseURL?: string;
  contextWindow?: number;
  maxTokens?: number;
  apiKeyConfigured: boolean;
}
export interface ModelSettingsView {
  revision: number;
  credentialsAvailable: boolean;
  credentialMessage?: string;
  roles: AgentModelView[];
}
export interface ModelSettingsCommand {
  action: 'save' | 'reset' | 'test';
  projectId: string;
  expectedRevision: number;
  target: string;
  model?: string;
  baseURL?: string;
  contextWindow?: number;
  maxTokens?: number;
  auth?: 'keep' | 'replace' | 'none';
  connectionId?: string;
  apiKey?: string;
}
