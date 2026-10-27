# IA CENTRAL — NEURAL COMMAND

Aplicação Node.js com dashboard responsivo, login Discord OAuth2, bot Discord e chat OpenAI com chamadas de ferramentas para operações autorizadas.

## Requisitos
- Node.js 20+
- Aplicação criada no Discord Developer Portal
- Bot adicionado ao servidor com permissões adequadas
- Chave da API OpenAI com acesso e faturamento configurados

## Instalação
1. Extraia o ZIP.
2. Abra a pasta no terminal.
3. Execute `npm install`.
4. Copie `.env.example` para `.env`.
5. Preencha as variáveis descritas abaixo.
6. No Discord Developer Portal, adicione exatamente o Redirect URI definido em `DISCORD_REDIRECT_URI`.
7. Inicie com `npm start`.
8. Acesse `http://localhost:3000`.

## Configuração Discord
No Developer Portal:
- Crie uma Application.
- Em OAuth2, configure o Redirect URI, client ID e client secret.
- Crie um Bot e copie o token para `DISCORD_BOT_TOKEN`.
- Convide o bot para o servidor com `bot` e `applications.commands` (o projeto atual usa comandos via chat do painel) e permissões: View Channels, Send Messages, Manage Channels, Kick Members, Ban Members, Moderate Members.
- Coloque o ID do servidor em `DISCORD_GUILD_ID`.
- Mantenha o cargo do bot acima dos cargos que ele precisa moderar.

OAuth2 solicita `identify` e `guilds` no fluxo. A aplicação usa login Discord e exige que o usuário exista no servidor configurado e tenha permissão administrativa/de moderação. Para produção, amplie o fluxo para armazenar tokens OAuth cifrados e permitir seleção de múltiplos servidores.

## Configuração OpenAI
Coloque sua chave em `OPENAI_API_KEY` e um modelo disponível em `OPENAI_MODEL`. A chave fica no backend e nunca é enviada ao navegador. O uso da API pode gerar custos conforme sua conta e modelo.

## Segurança e limitações importantes
- Nunca publique o `.env`, tokens ou secrets.
- Use HTTPS e um armazenamento persistente de sessões em produção; o `MemoryStore` padrão do express-session é apenas para desenvolvimento.
- Configure `SESSION_SECRET` forte e único.
- Use um banco de dados e logs de auditoria antes de disponibilizar para uma equipe.
- A aplicação não é produto oficial do Exército Brasileiro.
- A seção de notícias aponta para fontes oficiais, mas ainda não implementa agregador RSS/API.
- O navegador integrado não incorpora arbitrariamente sites externos; links abrem em nova aba.
- A rota de moderação executa ações reais no Discord. Teste primeiro em servidor privado e com contas de teste.
- Nunca dê ao bot permissões maiores do que as necessárias.
- A confirmação humana adicional para ações destrutivas deve ser implementada antes de uso em produção; por padrão, o bot só chama ferramentas quando a solicitação no chat é explícita.

## Endpoints
- `GET /api/status`
- `GET /api/me`
- `GET /auth/discord`
- `GET /auth/discord/callback`
- `POST /auth/logout`
- `POST /api/chat`

## Próximas etapas recomendadas
Adicionar banco de dados (PostgreSQL/SQLite), histórico persistente, CSRF, rate limiting, auditoria, seleção segura de servidores OAuth, confirmação explícita antes de ban/kick, RSS oficial e integração Discord com fluxos de tickets configuráveis.
