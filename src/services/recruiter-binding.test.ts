import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  resetRecruiterBindingCacheForTests,
  resolveRecruiterUsername,
} from "./recruiter-binding.ts";

const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL_URL = process.env["REPLY_AUTHORITY_URL"];
const ORIGINAL_TOKEN = process.env["REPLY_AUTHORITY_BEARER_TOKEN"];
const ORIGINAL_CONFIGURED = process.env["REPLY_POLICY_TUNER_PREVIEW_RECRUITER_USERNAME"];

interface StubCall {
  readonly url: string;
  readonly body: unknown;
}

/**
 * 替换全局 fetch，统计对 resolve-recruiter-binding 的调用次数。
 * responder 根据请求 body.username 返回该账号对应的 tenantId（或 404）。
 */
function stubFetch(
  responder: (username: string) => { tenantId: string } | undefined,
): { calls: StubCall[] } {
  const calls: StubCall[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const body =
      init?.body !== undefined && typeof init.body === "string"
        ? (JSON.parse(init.body) as { username?: string })
        : {};
    calls.push({ url, body });

    const username = body.username ?? "";
    const match = responder(username);
    if (match === undefined) {
      return new Response(JSON.stringify({ statusCode: 404, message: "not found" }), {
        status: 404,
        headers: { "content-type": "application/json" },
      });
    }

    return new Response(
      JSON.stringify({
        tenantId: match.tenantId,
        recruiterBinding: { platform: "zhipin", username },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;

  return { calls };
}

describe("recruiter binding cache", () => {
  beforeEach(() => {
    process.env["REPLY_AUTHORITY_URL"] = "https://ras.test";
    process.env["REPLY_AUTHORITY_BEARER_TOKEN"] = "test-token";
    delete process.env["REPLY_POLICY_TUNER_PREVIEW_RECRUITER_USERNAME"];
    resetRecruiterBindingCacheForTests();
  });

  afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH;
    resetRecruiterBindingCacheForTests();
    restoreEnv("REPLY_AUTHORITY_URL", ORIGINAL_URL);
    restoreEnv("REPLY_AUTHORITY_BEARER_TOKEN", ORIGINAL_TOKEN);
    restoreEnv("REPLY_POLICY_TUNER_PREVIEW_RECRUITER_USERNAME", ORIGINAL_CONFIGURED);
  });

  function restoreEnv(name: string, value: string | undefined): void {
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }

  it("caches a successful resolution and reuses it without another round-trip", async () => {
    const { calls } = stubFetch((username) =>
      username === "张三" ? { tenantId: "demo-tenant-a" } : undefined,
    );

    const first = await resolveRecruiterUsername(undefined, "张三");
    assert.equal(first.ok, true);
    assert.deepEqual(first.data, { tenantId: "demo-tenant-a", username: "张三" });
    assert.equal(calls.length, 1);

    // 第二次相同 tenantId+username：命中缓存，不再发请求
    const second = await resolveRecruiterUsername(undefined, "张三");
    assert.equal(second.ok, true);
    assert.deepEqual(second.data, first.data);
    assert.equal(calls.length, 1, "应命中缓存，不应产生第二次网络往返");
  });

  it("reuses the resolution across explicit tenantId validation calls", async () => {
    const { calls } = stubFetch((username) =>
      username === "张三" ? { tenantId: "demo-tenant-a" } : undefined,
    );

    // 模拟 resolve_recruiter_binding（auto-resolve）后 preview 带 tenantId 复用
    const resolved = await resolveRecruiterUsername(undefined, "张三");
    assert.equal(resolved.ok, true);
    assert.equal(calls.length, 1);

    const previewBinding = await resolveRecruiterUsername("demo-tenant-a", "张三");
    assert.equal(previewBinding.ok, true);
    assert.deepEqual(previewBinding.data, { tenantId: "demo-tenant-a", username: "张三" });
    // tenantId 维度是独立 key（一次校验往返），但同一 key 的二次调用才命中缓存
    assert.equal(calls.length, 2);

    const previewAgain = await resolveRecruiterUsername("demo-tenant-a", "张三");
    assert.equal(previewAgain.ok, true);
    assert.equal(calls.length, 2, "同一 tenantId+username 第二次应命中缓存");
  });

  it("does not cache failures", async () => {
    const { calls } = stubFetch(() => undefined); // 始终 404

    const first = await resolveRecruiterUsername("demo-tenant-a", "查无此人");
    assert.equal(first.ok, false);
    const callsAfterFirst = calls.length;
    assert.ok(callsAfterFirst >= 1);

    const second = await resolveRecruiterUsername("demo-tenant-a", "查无此人");
    assert.equal(second.ok, false);
    assert.ok(
      calls.length > callsAfterFirst,
      "失败结果不应被缓存，第二次仍应重新尝试解析",
    );
  });

  it("skips caching entirely when TTL is zero", async () => {
    resetRecruiterBindingCacheForTests(0);
    const { calls } = stubFetch((username) =>
      username === "张三" ? { tenantId: "demo-tenant-a" } : undefined,
    );

    await resolveRecruiterUsername(undefined, "张三");
    await resolveRecruiterUsername(undefined, "张三");
    assert.equal(calls.length, 2, "TTL=0 时应禁用缓存，每次都重新解析");
  });

  it("expires cached entries after the TTL window", async () => {
    resetRecruiterBindingCacheForTests(1); // 1ms TTL
    const { calls } = stubFetch((username) =>
      username === "张三" ? { tenantId: "demo-tenant-a" } : undefined,
    );

    await resolveRecruiterUsername(undefined, "张三");
    assert.equal(calls.length, 1);

    await new Promise((resolve) => setTimeout(resolve, 5));

    await resolveRecruiterUsername(undefined, "张三");
    assert.equal(calls.length, 2, "过期后应重新解析");
  });
});
