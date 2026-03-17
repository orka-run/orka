// --- Primary exports: LocalClient + RemoteClient + Server ---
export { createLocalClient } from "./local-client";
export type { PairingConfig } from "./local-client";
export { startServer } from "./server";
export type { ServerOptions } from "./server";
export { createDaemonContext } from "./daemon-context";
export type { DaemonContext } from "./daemon-context";

// --- CLI-local utilities (not part of OrkaService) ---
export { loadConfig, loadProjectConfig, mergeConfigs, resolveDefaults } from "./config";
export type { OrkaConfig, ResolvedDefaults, PerBackendDefaults } from "./config";
export { initTracing, shutdownTracing, getTracer, getMeter, getDaemonMetrics, queryMetricSnapshot, withSpan, withSpanSync, setLogLevel } from "./tracing";
export type { DaemonMetrics, LogLevel, MetricSnapshot } from "./tracing";
export {
  addProject,
  removeProject,
  listProjects,
  resolveProject,
  projectNameForPath,
} from "./projects";
export type { ProjectEntry } from "./projects";
export { getOrkaHome } from "./db";
export { createNodeRegistry } from "./node-registry";
export type { NodeRegistry } from "./node-registry";
export { createRemoteNodeManager } from "./remote-nodes";
export type { RemoteNodeManager, RemoteNodeHandle } from "./remote-nodes";
export { createAggregatingClient } from "./aggregating-client";
export { formatLog, formatEvent, parseLine } from "./log-formatter";
export { createDrainableWorker, type DrainableWorker } from "./drainable-worker";
export * from "./adapters";
export { ProviderAdapterRegistry } from "./provider-registry";
export { ProviderService } from "./provider-service";
export * from "./orchestration";
