import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildPolicyComparisonRowsFromDiff,
  formatPolicyComparisonTable,
  formatReplyComparisonTable,
} from "./comparison.ts";

describe("comparison formatters", () => {
  it("formats policy comparison table", () => {
    const markdown = formatPolicyComparisonTable([
      { label: "提问方式", before: "两个", after: "一个" },
    ]);
    assert.match(markdown, /提问方式/);
    assert.match(markdown, /\| 修改前 \|/);
  });

  it("builds rows from API diff", () => {
    const rows = buildPolicyComparisonRowsFromDiff([
      { path: "persona.questionStyle", before: "两个", after: "一个" },
    ]);
    assert.equal(rows[0]?.label, "提问方式");
    assert.equal(rows[0]?.before, "两个");
  });

  it("formats reply comparison with sample message", () => {
    const markdown = formatReplyComparisonTable({
      sampleMessage: "你好",
      currentReply: "回复 A",
      previewReply: "回复 B",
      stage: "trust_building",
    });
    assert.match(markdown, /示例候选人消息/);
    assert.match(markdown, /回复 A/);
    assert.match(markdown, /trust_building/);
  });
});
