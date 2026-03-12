import { describe, test, expect } from "bun:test";
import { SingleInstanceCluster } from "./cluster";

describe("SingleInstanceCluster", () => {
  test("defaults to local instance", () => {
    const cluster = new SingleInstanceCluster();
    const instances = cluster.listInstances();
    expect(instances.length).toBe(1);
    expect(instances[0]?.id).toBe("local");
    expect(instances[0]?.healthy).toBe(true);
  });

  test("custom id and url", () => {
    const cluster = new SingleInstanceCluster({ id: "relay-1", url: "ws://relay.example.com:7390" });
    const instance = cluster.listInstances()[0];
    expect(instance?.id).toBe("relay-1");
    expect(instance?.url).toBe("ws://relay.example.com:7390");
  });

  test("isLocal always returns true", () => {
    const cluster = new SingleInstanceCluster();
    expect(cluster.isLocal("any-account")).toBe(true);
    expect(cluster.isLocal("another")).toBe(true);
  });

  test("getInstanceForAccount returns the single instance", () => {
    const cluster = new SingleInstanceCluster();
    const instance = cluster.getInstanceForAccount("any-account");
    expect(instance.id).toBe("local");
  });

  test("register and deregister are no-ops", () => {
    const cluster = new SingleInstanceCluster();
    // Should not throw
    cluster.register({ id: "other", url: "ws://other", activeAccounts: 0, connections: 0, healthy: true });
    cluster.deregister("other");
    // Still just one instance
    expect(cluster.listInstances().length).toBe(1);
  });

  test("updateStats updates instance metrics", () => {
    const cluster = new SingleInstanceCluster();
    cluster.updateStats(10, 25);
    const instance = cluster.listInstances()[0];
    expect(instance?.activeAccounts).toBe(10);
    expect(instance?.connections).toBe(25);
  });
});
