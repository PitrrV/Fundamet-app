// DOČASNÝ diagnostický skript — smazat po použití. Empirické ověření gpt-5.6-luna
// (parametry temperature/reasoning_effort, structured outputs, cena) před migrací produkčního kódu.
import OpenAI from "openai";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const schema = {
  type: "json_schema",
  json_schema: {
    name: "test",
    strict: true,
    schema: {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
      additionalProperties: false,
    },
  },
};

async function test(label, model, extra) {
  try {
    const completion = await openai.chat.completions.create({
      model,
      messages: [
        { role: "system", content: "Odpověz strukturovaným JSON, pole text vyplň jednou českou větou o počasí." },
        { role: "user", content: "Jak je dnes venku?" },
      ],
      response_format: schema,
      ...extra,
    });
    console.log(
      `OK   [${label}] content=${completion.choices[0].message.content} usage=${JSON.stringify(completion.usage)}`
    );
  } catch (err) {
    console.log(`FAIL [${label}] ${err.status ?? ""} ${err.message}`);
  }
}

await test("luna, bez extra", "gpt-5.6-luna", {});
await test("luna, temperature 0.4", "gpt-5.6-luna", { temperature: 0.4 });
await test("luna, reasoning_effort low", "gpt-5.6-luna", { reasoning_effort: "low" });
await test("luna, reasoning_effort minimal", "gpt-5.6-luna", { reasoning_effort: "minimal" });
await test("luna, reasoning_effort none", "gpt-5.6-luna", { reasoning_effort: "none" });
await test("4o-mini, temperature 0.4 (kontrola)", "gpt-4o-mini", { temperature: 0.4 });
