import Bao from "baojs";
import type { ParsedEvent, ReconnectInterval } from "eventsource-parser";
import { createParser } from "eventsource-parser";

const app = new Bao();
const port = parseInt(process.env.PORT || "8008");

const OPENAI_API_HOST = "api.openai.com";

const APIKEY = process.env.OPEN_AI_KEY;
const APPID = process.env.APPID;
const SECRET = process.env.SECRET;

const clients = new Map();
const decoder = new TextDecoder();

app.ws("/ws/:openid", {
  open: (ws) => {
    const openid = ws.data.ctx.params.openid;
    ws.data.uuid = openid;
    if (openid && !clients.get(openid)) {
      clients.set(openid, ws);
    }
  },
  close: (ws) => {
    const openid = ws.data.ctx.params.openid;
    if (openid && clients.get(openid)) {
      clients.delete(openid);
    }
  },
  message: async (ws, msg) => {
    const openid = ws.data.ctx.params.openid;
    try {
      console.log("socket message:", msg);
      const { type, action, key, ...options } = JSON.parse(msg as string);
      // 采用 socket 方式返回分流信息
      const client = clients.get(openid) || ws;
      if (!client) return;
      if (type === "chat") {
        const auth = key.includes("l5e2e0") ? APIKEY : key;
        const url = `https://${OPENAI_API_HOST}${action}`;
        const rawRes = await fetch(url, {
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${auth}`,
          },
          method: "POST",
          body: JSON.stringify({
            // max_tokens: 4096 - tokens,
            stream: true,
            ...options,
          }),
        }).catch((err) => {
          return client.send(
            JSON.stringify({
              type: "fail",
              status: 500,
              message: err.message,
            })
          );
        });

        // console.log('rawRes:', rawRes)
        if (!rawRes.ok) {
          return client.send(
            JSON.stringify({
              type: "fail",
              status: rawRes.status,
              message: rawRes.statusText,
            })
          );
        }
        const streamParser = (event: ParsedEvent | ReconnectInterval) => {
          if (event.type === "event") {
            const data = event.data;
            if (data === "[DONE]") {
              return client.send(JSON.stringify({ type: "done", status: 200 }));
            }
            try {
              const json = JSON.parse(data);
              const text = json.choices[0].delta?.content;
              client.send(
                JSON.stringify({ type: "ok", status: 200, content: text })
              );
            } catch (e) {
              client.send(
                JSON.stringify({
                  type: "fail",
                  status: 200,
                  content: e.message.toString(),
                })
              );
            }
          }
        };
        const parser = createParser(streamParser);
        for await (const chunk of rawRes.body as any) {
          parser.feed(decoder.decode(chunk));
        }
      } else {
        ws.send(new Date().toString());
      }
    } catch (e) {
      ws.send(e.message);
    }
  },
});

app.get("/jscode2session", (ctx) => {
  return fetch(
    `https://api.weixin.qq.com/sns/jscode2session?js_code=${
      (ctx.query as any).js_code
    }&appid=${APPID}&secret=${SECRET}&grant_type=authorization_code`
  );
});

app.get("/", (ctx) => {
  return ctx.sendText("Hello world from Bao.js running on fly.io!");
});

const server = app.listen({ port: port });
console.log(`Server listening on ${server.hostname}:${port}`);
