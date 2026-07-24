# Proxy de citações — deploy no Render (grátis)

Isto substitui as Cloud Functions do Firebase (que exigiam o plano pago Blaze).
O site continua no Firebase; só a IA e o backup diário automático passam por aqui.

## Passos no Render

> Correção (2026-07-24): o Render hoje **exige** conectar um repositório GitHub, GitLab
> ou Bitbucket — não existe mais upload manual de pasta para Web Service. Por isso o
> código desta pasta foi colocado num repositório Git próprio (separado do repo do
> SuperApp), pronto para ser enviado ao GitHub.

1. Acesse https://render.com e entre (pode usar Google) → **Get Started**.
2. Na primeira vez, conecte sua conta GitHub em **Account Settings → Git Deployment
   Credentials → Add credential**.
3. **New +** → **Web Service** → selecione o repositório `proxy-citacoes-anthropic`
   (ou o nome que você deu) na lista → **Connect**.
4. Configure:
   - **Name:** proxy-citacoes-anthropic
   - **Runtime:** Node
   - **Build Command:** `npm install`
   - **Start Command:** `node server.js`
   - **Instance Type:** Free
5. Em **Environment Variables**, adicione:
   - `ANTHROPIC_API_KEY` = sua chave (começa com `sk-ant-`) — para a IA
   - `ALLOWED_ORIGIN` = `https://grupo-de-pesquisa-9e35f.web.app`
   - `FIREBASE_PROJECT_ID` = `grupo-de-pesquisa-9e35f`
   - `FIREBASE_SERVICE_ACCOUNT_JSON` = (ver abaixo) — para o backup diário
   - `BACKUP_SECRET` = uma senha longa qualquer, só sua (protege o disparo do backup)
6. **Create Web Service**. Aguarde ~2 min. Copie a URL gerada
   (ex.: `https://proxy-citacoes-anthropic-xxxx.onrender.com`).
7. **Me passe essa URL** — eu religo o site (`IA_PROXY_URL`) e você publica pelo `DEPLOY.bat`.

## Como conseguir a `FIREBASE_SERVICE_ACCOUNT_JSON`
Isso dá ao proxy permissão de servidor para gravar o backup no Firestore (sem isso a IA
funciona normal, só o backup automático fica desligado):

1. Abra: https://console.firebase.google.com/project/grupo-de-pesquisa-9e35f/settings/serviceaccounts/adminsdk
2. Clique em **"Gerar nova chave privada"** → baixa um arquivo `.json`.
3. Abra esse arquivo, copie **todo o conteúdo** (é um JSON de uma linha ou várias).
4. Cole esse conteúdo inteiro como valor da variável `FIREBASE_SERVICE_ACCOUNT_JSON` no Render.
5. **Guarde esse arquivo `.json` em local seguro e nunca o publique/compartilhe** — ele dá
   acesso total ao banco de dados do site.

## Ligar o backup diário automático (grátis)
O Render sozinho não tem "agendador" no plano free. Usamos um serviço externo grátis que
faz uma chamada por dia — é o mesmo princípio do "self-ping" que você já usa no SuperApp.

1. Acesse https://cron-job.org e crie uma conta grátis.
2. Crie um novo cron job:
   - **URL:** `https://SUA-URL-DO-RENDER.onrender.com/backup-diario`
   - **Método:** POST
   - **Cabeçalho (Header):** `X-Backup-Secret` = o mesmo valor que você colocou em `BACKUP_SECRET`
   - **Horário:** uma vez por dia (ex.: 4h da manhã)
3. Pronto — todo dia, no horário escolhido, o backup é gerado automaticamente,
   organizado por corrente crítica, com contagem por tema.
4. No site, o botão **"📅 Backups diários"** (ao lado de "Exportar backup agora") lista
   os últimos 30 dias e permite baixar qualquer um.

## Segurança
- A chave da Anthropic e a chave de serviço do Firebase ficam só no Render — nunca no navegador.
- A IA só responde para o e-mail felipevigneron@gmail.com (valida o token de login do Firebase).
- O backup diário só roda com a senha certa (`X-Backup-Secret`), não pelo login — porque
  quem dispara é um robô externo (cron-job.org), não um navegador logado.
- Limite de 60 chamadas de IA por hora.

## Sobre o plano free do Render
O serviço "dorme" após ~15 min sem uso; a chamada seguinte demora alguns segundos a mais
para "acordar". Isso é irrelevante para a IA (você já espera a resposta) e para o backup
diário (o cron-job.org tenta de novo automaticamente se a primeira chamada só acordar o
servidor sem completar a tempo).
