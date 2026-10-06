// Run against the real local OIDC/BFF stack. Provider and retrieval doubles are
// forbidden here. Pass a protected human access-token file; never print it.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
const token = (
  await fs.readFile(process.env.AGENT_ACCESS_TOKEN_FILE, "utf8")
).trim();
const scope = {
  document_id: process.env.AGENT_DOCUMENT_ID,
  document_version: Number(process.env.AGENT_DOCUMENT_VERSION ?? 1),
};
const question =
  process.env.AGENT_QUESTION ??
  "Compare the distinct technical assumptions and conclusions in this PDF. Retrieve each part separately if the first evidence does not support both. Cite the pages and state missing evidence.";
const response = await fetch(
  `${process.env.AGENT_BFF_URL ?? "http://127.0.0.1:4002"}/v1/assistant/agent`,
  {
    method: "POST",
    signal: AbortSignal.timeout(125000),
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ question, selected_document: scope }),
  },
);
const payload = await response.json();
console.log(JSON.stringify({ status: response.status, ...payload }, null, 2));
assert.equal(
  response.status,
  200,
  `agent request failed with ${response.status}`,
);
assert.equal(payload.tool, "answer");
assert.ok(
  payload.tool_calls >= 2 && payload.tool_calls <= 3,
  "actual bounded repeated retrieval required",
);
assert.ok(payload.observation_ids.length >= 1);
assert.ok(payload.content[0].text.trim().length > 0);
assert.ok(payload.citations.length > 0, "authorized PDF provenance required");
for (const citation of payload.citations) {
  assert.equal(citation.document_id, scope.document_id);
  assert.equal(citation.document_version, scope.document_version);
  assert.ok(
    citation.page_start >= 1 && citation.page_end >= citation.page_start,
  );
}
console.log(
  JSON.stringify(
    {
      mode: "live-local",
      synthetic_provider: false,
      synthetic_retrieval: false,
      run_id: payload.run_id,
      tool_calls: payload.tool_calls,
      observation_ids: payload.observation_ids,
      selected_document: scope,
      citations: payload.citations,
      answer: payload.content[0].text,
    },
    null,
    2,
  ),
);
