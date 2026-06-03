import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { summarizePolicyForOperator } from "./policy-summary.ts";

describe("policy-summary", () => {
  it("summarizes persona, stage CTA, and protection rules without version", () => {
    const text = summarizePolicyForOperator({
      persona: {
        tone: "口语化",
        questionStyle: "单轮只问一个最关键的问题",
        addressStyle: "你",
        professionalIdentity: "资深招聘专员",
      },
      stageGoals: {
        trust_building: {
          primaryGoal: "建立信任",
          successCriteria: [],
          ctaStrategy: "先回应关切，再轻量引导",
        },
        private_channel: {
          primaryGoal: "加微信",
          successCriteria: [],
          ctaStrategy: "必要时才引导加微信",
        },
      },
      hardConstraints: {
        rules: [{ id: "r1", rule: "禁止承诺具体薪资数字", severity: "high" }],
      },
      factGate: { mode: "strict" },
    });

    assert.doesNotMatch(text, /版本号/);
    assert.match(text, /语气：口语化/);
    assert.match(text, /提问方式：单轮只问一个最关键的问题/);
    assert.match(text, /称呼：你/);
    assert.match(text, /【阶段策略】/);
    assert.match(text, /初次接触.*先回应关切/);
    assert.match(text, /加微信.*必要时才引导/);
    assert.match(text, /【保护规则】1 条/);
    assert.match(text, /禁止承诺具体薪资/);
    assert.match(text, /【事实核查】严格模式/);
  });

  it("appends operational warnings without version", () => {
    const text = summarizePolicyForOperator({ persona: { tone: "正式" } }, ["策略文件有告警"]);
    assert.match(text, /【提示】/);
    assert.match(text, /策略文件有告警/);
    assert.doesNotMatch(text, /版本号/);
  });
});
