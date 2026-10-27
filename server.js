import "dotenv/config";
import express from "express";
import session from "express-session";
import OpenAI from "openai";
import {
  Client, GatewayIntentBits, Partials, PermissionFlagsBits,
  ChannelType
} from "discord.js";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.set("trust proxy", 1);
app.use(express.json({ limit: "1mb" }));
app.use(session({
  name: "ia-central.sid",
  secret: process.env.SESSION_SECRET || "change-this-session-secret",
  resave: false, saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", maxAge: 8 * 60 * 60 * 1000 }
}));
app.use(express.static(path.join(__dirname, "public")));

const required = ["DISCORD_CLIENT_ID", "DISCORD_CLIENT_SECRET", "DISCORD_BOT_TOKEN", "OPENAI_API_KEY"];
const missing = required.filter(k => !process.env[k]);
const openai = process.env.OPENAI_API_KEY ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) : null;

const bot = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
  partials: [Partials.GuildMember]
});
let botReady = false;
if (process.env.DISCORD_BOT_TOKEN) {
  bot.login(process.env.DISCORD_BOT_TOKEN)
    .then(() => { botReady = true; console.log(`Bot conectado como ${bot.user.tag}`); })
    .catch(err => console.error("Falha ao conectar bot:", err.message));
}
bot.once("ready", () => { botReady = true; });

const baseUrl = process.env.BASE_URL || `http://localhost:${process.env.PORT || 3000}`;
const redirectUri = process.env.DISCORD_REDIRECT_URI || `${baseUrl}/auth/discord/callback`;
const oauthState = () => crypto.randomBytes(24).toString("hex");

function requireLogin(req, res, next) {
  if (!req.session.user) return res.status(401).json({ error: "Faça login com o Discord primeiro." });
  next();
}
function hasPerm(permissions, permission) {
  try { return BigInt(permissions || "0") & permission ? true : false; } catch { return false; }
}
async function getAuthorizedGuild(req, guildId) {
  const chosen = guildId || process.env.DISCORD_GUILD_ID;
  if (!chosen) throw new Error("Configure DISCORD_GUILD_ID no .env ou escolha um servidor no painel.");
  const guild = await bot.guilds.fetch(chosen).catch(() => null);
  if (!guild) throw new Error("O bot não está nesse servidor ou o ID está incorreto.");
  const member = await guild.members.fetch(req.session.user.id).catch(() => null);
  if (!member) throw new Error("Sua conta não foi encontrada nesse servidor.");
  if (!member.permissions.has(PermissionFlagsBits.Administrator) &&
      !member.permissions.has(PermissionFlagsBits.BanMembers) &&
      !member.permissions.has(PermissionFlagsBits.KickMembers) &&
      !member.permissions.has(PermissionFlagsBits.ModerateMembers)) {
    throw new Error("Você não possui permissões de moderação neste servidor.");
  }
  return { guild, member };
}

app.get("/api/config", (req, res) => res.json({
  configured: { discord: !!(process.env.DISCORD_CLIENT_ID && process.env.DISCORD_CLIENT_SECRET),
    bot: botReady, openai: !!openai },
  missing: missing.filter(x => x !== "DISCORD_BOT_TOKEN" || !botReady)
}));
app.get("/auth/discord", (req, res) => {
  if (!process.env.DISCORD_CLIENT_ID || !process.env.DISCORD_CLIENT_SECRET) return res.status(503).send("Configure as credenciais OAuth2 no .env.");
  const state = oauthState(); req.session.oauthState = state;
  const params = new URLSearchParams({
    client_id: process.env.DISCORD_CLIENT_ID,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: "identify guilds",
    state
  });
  res.redirect(`https://discord.com/oauth2/authorize?${params}`);
});
app.get("/auth/discord/callback", async (req, res) => {
  try {
    if (!req.query.code || !req.query.state || req.query.state !== req.session.oauthState) return res.status(400).send("Autorização inválida. Tente novamente.");
    delete req.session.oauthState;
    const tokenResponse = await fetch("https://discord.com/api/oauth2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: process.env.DISCORD_CLIENT_ID,
        client_secret: process.env.DISCORD_CLIENT_SECRET,
        grant_type: "authorization_code",
        code: String(req.query.code),
        redirect_uri: redirectUri
      })
    });
    const token = await tokenResponse.json();
    if (!tokenResponse.ok) throw new Error(token.error_description || "Falha no OAuth2.");
    const userResponse = await fetch("https://discord.com/api/users/@me", { headers: { Authorization: `Bearer ${token.access_token}` } });
    const user = await userResponse.json();
    if (!userResponse.ok) throw new Error("Não foi possível obter seu perfil Discord.");
    req.session.user = { id: user.id, username: user.global_name || user.username, avatar: user.avatar };
    res.redirect("/");
  } catch (e) { res.status(400).send(`Erro no login Discord: ${e.message}`); }
});
app.post("/auth/logout", (req, res) => req.session.destroy(() => res.json({ ok: true })));
app.get("/api/me", (req, res) => res.json({ user: req.session.user || null }));

app.get("/api/guilds", requireLogin, async (req, res) => {
  try {
    const r = await fetch("https://discord.com/api/users/@me/guilds", {
      headers: { Authorization: `Bearer ${req.session.discordAccessToken || ""}` }
    });
    // O token OAuth é intencionalmente não persistido neste MVP; use guild configurada no .env.
    if (!process.env.DISCORD_GUILD_ID) return res.json({ guilds: [], note: "Defina DISCORD_GUILD_ID no .env para selecionar o servidor." });
    const g = await bot.guilds.fetch(process.env.DISCORD_GUILD_ID);
    return res.json({ guilds: [{ id: g.id, name: g.name }] });
  } catch { res.json({ guilds: [] }); }
});

const tools = [
  { type: "function", function: {
    name: "ban_member", description: "Banir um membro do servidor. Use apenas quando o usuário pedir claramente.",
    parameters: { type: "object", properties: { user_id: { type: "string" }, reason: { type: "string" } }, required: ["user_id", "reason"], additionalProperties: false }
  }},
  { type: "function", function: {
    name: "kick_member", description: "Expulsar um membro do servidor. Use apenas quando o usuário pedir claramente.",
    parameters: { type: "object", properties: { user_id: { type: "string" }, reason: { type: "string" } }, required: ["user_id", "reason"], additionalProperties: false }
  }},
  { type: "function", function: {
    name: "timeout_member", description: "Aplicar timeout em um membro por minutos (máximo 10080).",
    parameters: { type: "object", properties: { user_id: { type: "string" }, minutes: { type: "integer" }, reason: { type: "string" } }, required: ["user_id", "minutes", "reason"], additionalProperties: false }
  }},
  { type: "function", function: {
    name: "server_info", description: "Consultar informações básicas do servidor Discord.",
    parameters: { type: "object", properties: {}, additionalProperties: false }
  }},
  { type: "function", function: {
    name: "create_ticket_channel", description: "Criar um canal privado de suporte para o usuário solicitante.",
    parameters: { type: "object", properties: { topic: { type: "string" } }, required: ["topic"], additionalProperties: false }
  }}
];

async function executeTool(name, args, guild, actor) {
  if (name === "server_info") {
    return JSON.stringify({ name: guild.name, id: guild.id, members: guild.memberCount, channels: guild.channels.cache.size });
  }
  if (name === "create_ticket_channel") {
    if (!actor.permissions.has(PermissionFlagsBits.ManageChannels) && !actor.permissions.has(PermissionFlagsBits.Administrator))
      throw new Error("Você precisa de Gerenciar Canais para criar tickets.");
    const safe = String(args.topic).replace(/[^a-zA-Z0-9-]/g, "-").slice(0, 35) || "suporte";
    const channel = await guild.channels.create({
      name: `ticket-${safe}`,
      type: ChannelType.GuildText,
      topic: `Ticket aberto por ${actor.user.tag}: ${args.topic}`,
      permissionOverwrites: [
        { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
        { id: actor.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] },
        { id: bot.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ManageChannels] }
      ]
    });
    return JSON.stringify({ success: true, channel: `#${channel.name}` });
  }
  const target = await guild.members.fetch(args.user_id).catch(() => null);
  if (!target) throw new Error("Membro não encontrado. Peça o ID de usuário correto.");
  if (target.id === actor.id || target.id === guild.ownerId) throw new Error("Essa ação não pode ser aplicada a esse membro.");
  if (target.roles.highest.position >= actor.roles.highest.position && actor.id !== guild.ownerId && !actor.permissions.has(PermissionFlagsBits.Administrator))
    throw new Error("Hierarquia de cargos impede essa ação.");
  if (name === "ban_member") {
    if (!actor.permissions.has(PermissionFlagsBits.BanMembers)) throw new Error("Permissão Banir membros necessária.");
    if (!target.bannable) throw new Error("O bot não pode banir esse membro. Verifique a hierarquia e permissões do bot.");
    await target.ban({ reason: String(args.reason).slice(0, 450) });
    return JSON.stringify({ success: true, action: "ban", user: target.user.tag });
  }
  if (name === "kick_member") {
    if (!actor.permissions.has(PermissionFlagsBits.KickMembers)) throw new Error("Permissão Expulsar membros necessária.");
    if (!target.kickable) throw new Error("O bot não pode expulsar esse membro. Verifique a hierarquia e permissões do bot.");
    await target.kick(String(args.reason).slice(0, 450));
    return JSON.stringify({ success: true, action: "kick", user: target.user.tag });
  }
  if (name === "timeout_member") {
    if (!actor.permissions.has(PermissionFlagsBits.ModerateMembers)) throw new Error("Permissão Moderar membros necessária.");
    const mins = Math.max(1, Math.min(10080, Number(args.minutes) || 1));
    if (!target.moderatable) throw new Error("O bot não pode aplicar timeout nesse membro.");
    await target.timeout(mins * 60 * 1000, String(args.reason).slice(0, 450));
    return JSON.stringify({ success: true, action: "timeout", user: target.user.tag, minutes: mins });
  }
  throw new Error("Ferramenta desconhecida.");
}

app.post("/api/chat", requireLogin, async (req, res) => {
  try {
    if (!openai) return res.status(503).json({ error: "OPENAI_API_KEY não configurada no servidor." });
    if (!botReady) return res.status(503).json({ error: "Bot Discord ainda não está conectado." });
    const { message, guildId } = req.body || {};
    if (typeof message !== "string" || !message.trim() || message.length > 4000) return res.status(400).json({ error: "Mensagem inválida (máximo 4000 caracteres)." });
    const { guild, member } = await getAuthorizedGuild(req, guildId);
    const messages = [
      { role: "system", content: "Você é a IA CENTRAL, assistente administrativa em português brasileiro. Ajude com tarefas e administração do servidor conectado. Nunca afirme que executou uma ação antes do retorno da ferramenta. Para banir, expulsar, aplicar timeout ou criar ticket, só chame a ferramenta se o usuário pedir explicitamente. Se faltar ID, pergunte. Explique erros de permissão com clareza." },
      { role: "user", content: message.trim() }
    ];
    let completion = await openai.chat.completions.create({ model: process.env.OPENAI_MODEL || "gpt-4o-mini", messages, tools, tool_choice: "auto" });
    let answer = completion.choices[0]?.message;
    if (answer?.tool_calls?.length) {
      messages.push(answer);
      for (const call of answer.tool_calls) {
        let result;
        try {
          const args = JSON.parse(call.function.arguments || "{}");
          result = await executeTool(call.function.name, args, guild, member);
        } catch (e) { result = JSON.stringify({ success: false, error: e.message }); }
        messages.push({ role: "tool", tool_call_id: call.id, content: result });
      }
      completion = await openai.chat.completions.create({ model: process.env.OPENAI_MODEL || "gpt-4o-mini", messages });
      answer = completion.choices[0]?.message;
    }
    res.json({ answer: answer?.content || "Não consegui gerar uma resposta." });
  } catch (e) { res.status(400).json({ error: e.message || "Erro interno." }); }
});

app.get("/api/status", (req, res) => res.json({
  application: "IA CENTRAL — NEURAL COMMAND",
  discordOAuth: !!(process.env.DISCORD_CLIENT_ID && process.env.DISCORD_CLIENT_SECRET),
  discordBot: botReady,
  openai: !!openai
}));

const port = Number(process.env.PORT || 3000);
app.listen(port, () => {
  console.log(`IA CENTRAL disponível em ${baseUrl}`);
  if (missing.length) console.log("Configure no .env:", missing.join(", "));
});
