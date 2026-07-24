import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { prepareEvaluateCases } from "./build-evaluate-cases.ts";

describe("prepareEvaluateCases", () => {
  it("rejects primary-only input", () => {
    assert.throws(
      () =>
        prepareEvaluateCases(
          [
            {
              caseId: "primary-001",
              role: "primary",
              candidateMessage: "这个岗位需要什么条件？",
            },
          ],
          "这个岗位需要什么条件？",
        ),
      /至少需要 1 个 regression/,
    );
  });

  it("requires at least one primary case", () => {
    assert.throws(
      () =>
        prepareEvaluateCases(
          [
            {
              caseId: "regression-001",
              role: "regression",
              regressionScope: "related",
              candidateMessage: "回归场景",
            },
          ],
          "本次目标问题",
        ),
      /至少需要 1 个 primary/,
    );
  });

  it("rejects invented extra primary cases", () => {
    assert.throws(
      () =>
        prepareEvaluateCases(
          [
            {
              caseId: "requested-tone",
              role: "primary",
              candidateMessage: "我对这个岗位有兴趣",
            },
            {
              caseId: "invented-location",
              role: "primary",
              candidateMessage: "浦东有岗位吗",
            },
          ],
          "我对这个岗位有兴趣",
        ),
      /只能有 1 个 primary/,
    );
  });

  it("allows two regression cases for common scenarios", () => {
    const cases = prepareEvaluateCases(
      [
        {
          caseId: "requested-tone",
          role: "primary",
          candidateMessage: "我对这个岗位有兴趣",
        },
        {
          caseId: "tone-regression",
          role: "regression",
          regressionScope: "related",
          candidateMessage: "可以先简单聊聊吗",
        },
        {
          caseId: "location-regression",
          role: "regression",
          regressionScope: "general",
          candidateMessage: "浦东有岗位吗",
        },
      ],
      "我对这个岗位有兴趣",
    );

    assert.equal(cases.length, 3);
  });

  it("allows one regression case", () => {
    const cases = prepareEvaluateCases(
      [
        {
          caseId: "requested-tone",
          role: "primary",
          candidateMessage: "我对这个岗位有兴趣",
        },
        {
          caseId: "location-regression",
          role: "regression",
          regressionScope: "related",
          candidateMessage: "浦东有岗位吗",
        },
      ],
      "我对这个岗位有兴趣",
    );

    assert.equal(cases.length, 2);
  });

  it("rejects more than two regression cases", () => {
    assert.throws(
      () =>
        prepareEvaluateCases(
          [
            {
              caseId: "requested-tone",
              role: "primary",
              candidateMessage: "我对这个岗位有兴趣",
            },
            {
              caseId: "related-tone-regression",
              role: "regression",
              regressionScope: "related",
              candidateMessage: "我想再了解一下",
            },
            {
              caseId: "salary-regression",
              role: "regression",
              regressionScope: "general",
              candidateMessage: "薪资是多少",
            },
            {
              caseId: "location-regression",
              role: "regression",
              regressionScope: "general",
              candidateMessage: "浦东有岗位吗",
            },
          ],
          "我对这个岗位有兴趣",
        ),
      /最多只能有 2 个 regression/,
    );
  });

  it("requires every regression case to declare its scope", () => {
    assert.throws(
      () =>
        prepareEvaluateCases(
          [
            {
              caseId: "requested-tone",
              role: "primary",
              candidateMessage: "我对这个岗位有兴趣",
            },
            {
              caseId: "tone-regression",
              role: "regression",
              candidateMessage: "可以先简单聊聊吗",
            },
          ],
          "我对这个岗位有兴趣",
        ),
      /必须声明 regressionScope/,
    );
  });

  it("requires at least one related regression case", () => {
    assert.throws(
      () =>
        prepareEvaluateCases(
          [
            {
              caseId: "requested-tone",
              role: "primary",
              candidateMessage: "我对这个岗位有兴趣",
            },
            {
              caseId: "location-regression",
              role: "regression",
              regressionScope: "general",
              candidateMessage: "浦东有岗位吗",
            },
          ],
          "我对这个岗位有兴趣",
        ),
      /至少需要 1 个 regressionScope=related/,
    );
  });

  it("requires the primary case to reuse the preview sample message", () => {
    assert.throws(
      () =>
        prepareEvaluateCases(
          [
            {
              caseId: "invented-salary",
              role: "primary",
              candidateMessage: "薪资是多少",
            },
          ],
          "我对这个岗位有兴趣",
        ),
      /必须与 preview_policy_effect 返回的 sampleMessage 完全一致/,
    );
  });
});
