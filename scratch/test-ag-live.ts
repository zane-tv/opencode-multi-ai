import { getAccountManager } from "../lib/core/accounts.js";
import { createAntigravityAdapter } from "../lib/providers/antigravity/adapter.js";
import { createProviderFetch } from "../lib/core/provider-fetch.js";

async function main() {
  console.log("🚀 Testing Antigravity Native direct request...");
  const manager = getAccountManager();
  await manager.load();

  const accounts = manager.list("antigravity");
  console.log(`Pool has ${accounts.length} Antigravity accounts.`);

  const adapter = createAntigravityAdapter();
  const customFetch = createProviderFetch(adapter, manager);

  const startTime = Date.now();
  const res = await customFetch("https://daily-cloudcode-pa.googleapis.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gemini-3.8-flash",
      messages: [
        { role: "user", content: "Plan a 3-step migration for a database. Think step by step before answering." },
      ],
      stream: true,
    }),
  });

  console.log(`Status: ${res.status}`);
  if (!res.body) {
    console.error("No response body!");
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let firstTokenTime = 0;
  let fullText = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = decoder.decode(value);
    if (!firstTokenTime) {
      firstTokenTime = Date.now() - startTime;
    }
    const lines = chunk.split("\n");
    for (const line of lines) {
      if (line.startsWith("data:") && !line.includes("[DONE]")) {
        try {
          const parsed = JSON.parse(line.slice(5).trim());
          const delta = parsed.choices?.[0]?.delta;
          if (delta?.reasoning_content) {
            process.stdout.write("🧠 " + delta.reasoning_content.slice(0, 30) + "\n");
          }
          const text = delta?.content || "";
          if (text) {
            fullText += text;
            process.stdout.write(text);
          }
        } catch {}
      }
    }
  }

  const totalTime = Date.now() - startTime;
  console.log(`\n\n⚡ TTFT (Time To First Token): ${firstTokenTime}ms`);
  console.log(`⏱️ Total Time: ${totalTime}ms`);
  console.log(`📌 Sticky Account now: ${manager.sticky("antigravity")}`);
}

main().catch(console.error);
