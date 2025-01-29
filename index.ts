import { Hono } from "hono";
import { cors } from "hono/cors";
import { env } from "hono/adapter";
import { Index } from "@upstash/vector";
import { splitTextIntoWords } from "./utils/splitTextIntoWords";
import { splitTextIntoSemantics } from "./utils/splitTextIntoSemantics";
import { Environment, PROFANITY_THRESHOLD, WHITELIST } from "./constants";

const app = new Hono<{ Bindings: Environment }>();

app.use(cors());

app.post("/", async (c) => {
  if (c.req.header("Content-Type") !== "application/json") {
    return c.json({ error: "Invalid Content-Type" }, { status: 406 });
  }

  try {
    const { VECTOR_TOKEN, VECTOR_URL } = env<Environment>(c);

    const index = new Index({
      url: VECTOR_URL,
      token: VECTOR_TOKEN,
      cache: false,
    });

    const body = await c.req.json();
    const message = (body?.message as string)?.trim();

    if (!message) {
      return c.json({ error: "Argument message is required" }, { status: 400 });
    }

    if (message.length > 1000) {
      return c.json({ error: "Message is too long" }, { status: 413 });
    }

    const sanitizedMessage = message
      .split(/\s+/)
      .filter((word) => !WHITELIST.includes(word.toLowerCase()))
      .join(" ");

    const [wordChunks, semanticChunks] = await Promise.all([
      splitTextIntoWords(sanitizedMessage),
      splitTextIntoSemantics(sanitizedMessage),
    ]);

    const queryVector = async (text: string) => {
      const [vector] = await index.query({
        topK: 1,
        data: text,
        includeMetadata: true,
      });
      return vector
        ? { score: vector.score, text: vector.metadata?.text as string }
        : null;
    };

    const vectorResults = await Promise.all(
      [...wordChunks, ...semanticChunks].map(queryVector)
    );

    const flagged = vectorResults
      .filter((res) => res && res.score > PROFANITY_THRESHOLD)
      .sort((a, b) => b!.score - a!.score);

    if (flagged.length > 0) {
      return c.json({
        isProfanity: true,
        score: flagged[0]!.score,
        flaggedFor: flagged[0]!.text,
      });
    }
    return c.json({
      isProfanity: false,
      score: Math.max(...vectorResults.map((res) => res?.score ?? 0)),
    });
  } catch (error) {
    return c.json({ error: "Something went wrong" }, { status: 500 });
  }
});

export default app;
