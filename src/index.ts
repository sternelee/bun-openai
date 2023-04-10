import Bao from "baojs";
import type { ParsedEvent, ReconnectInterval } from "eventsource-parser";
import { createParser } from "eventsource-parser";
import * as tencentcloud from "tencentcloud-sdk-nodejs";

const app = new Bao();
const port = parseInt(process.env.PORT || "8008");

const OPENAI_API_HOST = "api.openai.com";

const APIKEY = process.env.OPEN_AI_KEY || "";
const APPID = process.env.APPID || "";
const SECRET = process.env.SECRET || "";

const MAX_DAY_COUNT = 3;
const MY_KEY = "l5e2e0";

const clients = new Map();
const decoder = new TextDecoder();

const TmsClient = tencentcloud.tms.v20201229.Client;

const clientConfig = {
  credential: {
    secretId: process.env.TENCENT_CLOUD_SID,
    secretKey: process.env.TENCENT_CLOUD_SKEY,
  },
  region: process.env.TENCENT_CLOUD_AP || "ap-singapore",
  profile: {
    httpProfile: {
      endpoint: "tms.tencentcloudapi.com",
    },
  },
};
const mdClient =
  process.env.TENCENT_CLOUD_SID && process.env.TENCENT_CLOUD_SKEY
    ? new TmsClient(clientConfig)
    : false;

const users: {
  [openid: string]: {
    day: string;
    count: number;
  };
} = {};

const getDayCount = (openid: string) => {
  const now = new Date().toLocaleDateString();
  if (users[openid] && users[openid].day === now) {
    if (users[openid].count >= MAX_DAY_COUNT) return 0;
    users[openid].count += 1;
    return users[openid].count;
  } else {
    users[openid] = {
      day: now,
      count: 1,
    };
    return 1;
  }
};

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
      const {
        type,
        action,
        key,
        moderation_level = "",
        ...options
      } = JSON.parse(msg as string);
      // 采用 socket 方式返回分流信息
      const client = clients.get(openid) || ws;
      if (!client) return;
      if (type === "chat") {
        const auth =
          key.includes(MY_KEY) && getDayCount(openid) > 0 ? APIKEY : key;
        const url = `https://${OPENAI_API_HOST}${action}`;
        const controller = new AbortController();
        const rawRes = await fetch(url, {
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${auth}`,
          },
          signal: controller.signal,
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
        const streamParser = async (event: ParsedEvent | ReconnectInterval) => {
          if (event.type === "event") {
            const data = event.data;
            if (data === "[DONE]") {
              return client.send(JSON.stringify({ type: "done", status: 200 }));
            }
            try {
              const json = JSON.parse(data);
              const text = json.choices[0].delta?.content;
              if (mdClient) {
                const md_result = await mdClient.TextModeration({
                  Content: text,
                });
                const md_check =
                  moderation_level == "high"
                    ? md_result.Suggestion != "Pass"
                    : md_result.Suggestion == "Block";
                if (md_check) {
                  controller.abort();
                  client.send(
                    JSON.stringify({
                      type: "ok",
                      status: 200,
                      content: "这个话题不适合讨论，换个话题吧",
                    })
                  );
                  return;
                }
              }
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

app.get("/jscode2session", async (ctx) => {
  const js_code = ctx.query.get("js_code") || "";
  const res = await fetch(
    `https://api.weixin.qq.com/sns/jscode2session?js_code=${js_code}&appid=${APPID}&secret=${SECRET}&grant_type=authorization_code`
  ).then((res) => res.json());
  return ctx.sendJson(res);
});

app.get("/", (ctx) => {
  return ctx.sendText("Hello world from Bao.js running on fly.io!");
});

const server = app.listen({ port: port });
console.log(`Server listening on ${server.hostname}:${port}`);
