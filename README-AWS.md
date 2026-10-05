# Painel de Sistemas — produção na AWS

Arquitetura: **CloudFront** na frente de duas origens — o `index.html` num bucket
**S3** e a rota `/api/dados` numa **Lambda** publicada por **API Gateway (HTTP API)**.
Com isso o site e a API ficam no mesmo domínio, não existe CORS, e a chave da Nekt
nunca chega ao navegador.

```
navegador ──► CloudFront ──┬── /            ──► S3 (index.html)
                           └── /api/dados   ──► API Gateway ──► Lambda ──► Nekt
```

---

## Onde fica a chave da Nekt

Em **uma única lugar**: a variável de ambiente `NEKT_API_KEY` da função Lambda.

Ela não está escrita em nenhum arquivo deste pacote. O código a lê assim:

```js
const chave = process.env.NEKT_API_KEY;
```

Isso é padrão do Node e funciona igual em Lambda, ECS, EC2 ou qualquer outro lugar.
Manter a chave fora do código significa que ela não entra no repositório, não entra
no `.zip` do deploy, não aparece no histórico do Git, e pode ser trocada em 30
segundos pelo console — sem publicar código novo.

> **Antes de ir para produção:** gere uma chave nova na Nekt. A chave usada na Vercel
> apareceu num print de tela e deve ser considerada comprometida. Depois de trocar,
> revogue a antiga.

---

## Passo 1 — Criar a função Lambda

1. Console da AWS → **Lambda** → *Create function* → *Author from scratch*
   - **Name:** `painel-sistemas-api`
   - **Runtime:** `Node.js 22.x` (ou 20.x — qualquer um a partir do 20)
   - **Architecture:** `arm64` (mais barato, mesmo desempenho aqui)
   - **Region:** `sa-east-1` (São Paulo) — menor latência para a equipe

2. Suba o código: *Upload from* → *.zip file* → `painel-sistemas-api.zip`
   (o zip está neste pacote; contém `index.mjs` e `package.json`)

3. **Configuration → General configuration → Edit:**
   - **Timeout:** `30 segundos`
     O padrão da AWS é 3 segundos. A consulta na Nekt leva de 5 a 20 segundos —
     com o padrão, a função é morta antes de responder, sempre.
   - **Memory:** `256 MB` é suficiente.

4. **Configuration → Environment variables → Edit → Add:**
   - Key: `NEKT_API_KEY`
   - Value: a chave nova da Nekt

   Confira que a chave está no campo **Value**, não no campo **Key**.

5. (Opcional, recomendado) **Configuration → Environment variables → Encryption in
   transit:** marque *Enable helpers for encryption in transit* se quiser que a
   chave fique cifrada com uma KMS própria em vez da chave gerenciada pela AWS.

---

## Passo 2 — Publicar pelo API Gateway

1. Console → **API Gateway** → *Create API* → **HTTP API** → *Build*
2. **Integrations:** Lambda → selecione `painel-sistemas-api`
3. **Routes:** método `GET`, caminho `/dados`
4. **Stage:** `$default`, com *Auto-deploy* ligado
5. Anote a *Invoke URL*, algo como
   `https://abc123.execute-api.sa-east-1.amazonaws.com`

**Teste agora, antes de seguir:**

```bash
curl -i https://abc123.execute-api.sa-east-1.amazonaws.com/dados
```

| O que voltou | Significado |
|---|---|
| `200` com `{"atualizado_em":…,"linhas":[…]}` | tudo certo |
| `500` falando de `NEKT_API_KEY` | a variável de ambiente não foi salva |
| `502` falando que a tabela respondeu sem registros | a Lambda está boa; falta rodar o conector na Nekt |
| `502` "demorou demais" | o timeout da Lambda ainda está em 3s |
| `403` da própria Nekt | a chave está errada ou foi revogada |

---

## Passo 3 — Hospedar o `index.html`

1. Crie um bucket S3, ex.: `painel-sistemas-vilabr`
   - **Block all public access: ligado.** O bucket não precisa ser público; quem vai
     ler é o CloudFront, via OAC.
2. Suba `web/index.html` na raiz do bucket.

---

## Passo 4 — CloudFront amarrando os dois

1. Console → **CloudFront** → *Create distribution*

2. **Origem 1 — o site**
   - Origin domain: o bucket S3
   - Origin access: **Origin access control (OAC)** → crie uma nova
   - O console oferece a política de bucket pronta; copie e aplique no S3
   - *Default root object:* `index.html`

3. **Origem 2 — a API**
   - Origin domain: o host da Invoke URL, **sem o `https://` e sem caminho**
     (`abc123.execute-api.sa-east-1.amazonaws.com`)
   - Protocol: *HTTPS only*

4. **Behavior do site** (o `Default (*)`)
   - Origin: o bucket
   - Viewer protocol policy: *Redirect HTTP to HTTPS*
   - Cache policy: `CachingOptimized`

5. **Behavior da API** — *Create behavior*
   - Path pattern: `/api/*`
   - Origin: o API Gateway
   - Viewer protocol policy: *Redirect HTTP to HTTPS*
   - Allowed methods: `GET, HEAD, OPTIONS`
   - Cache policy: `CachingDisabled`
     *(a própria Lambda manda o `Cache-Control` certo em cada resposta; deixar o
     CloudFront decidir sozinho é o que faria um erro ficar preso no cache)*
   - Origin request policy: `AllViewerExceptHostHeader`

6. **Function association no behavior `/api/*`** — o CloudFront repassa o caminho
   inteiro, então `/api/dados` chegaria no API Gateway como `/api/dados`, e a rota lá
   é `/dados`. Duas saídas, escolha uma:

   **(a) Mais simples:** mude a rota do API Gateway de `/dados` para `/api/dados`.
   Nada mais a fazer.

   **(b) Com reescrita:** crie uma CloudFront Function (*viewer request*) no behavior:

   ```js
   function handler(event) {
     event.request.uri = event.request.uri.replace(/^\/api/, '');
     return event.request;
   }
   ```

   A opção (a) é a que eu recomendo — uma coisa a menos para manter.

7. *Create*, e espere o deploy (uns 5 minutos).

---

## Passo 5 — Conferir

Abra a URL do CloudFront. Você deve ver o painel carregando os dados.

Se aparecer uma mensagem de erro na tela, ela agora **diz o que houve** — status,
content-type e o início da resposta — em vez do antigo "não foi possível carregar".

---

## Domínio próprio (opcional)

1. **Certificate Manager**, na região **us-east-1** (obrigatório para CloudFront):
   peça um certificado para `painel.vilabr.com.br`
2. Valide por DNS
3. No CloudFront: *Alternate domain names* → `painel.vilabr.com.br`, e selecione o
   certificado
4. No DNS: um registro `CNAME` (ou `A` do tipo *alias*, se o domínio estiver no
   Route 53) apontando para o domínio da distribuição

---

## Se o site e a API ficarem em domínios diferentes

Esse é o caminho alternativo, caso você não queira o CloudFront na frente da API.

1. Em `web/index.html`, troque a constante no topo do bloco de boot:
   ```js
   const API_URL = 'https://abc123.execute-api.sa-east-1.amazonaws.com/dados';
   ```
2. Na Lambda, adicione a variável de ambiente:
   - Key: `ALLOWED_ORIGIN`
   - Value: a URL exata do site, ex. `https://painel.vilabr.com.br`
     (sem barra no final)

A função já trata o preflight `OPTIONS` e devolve os cabeçalhos de CORS sozinha.

---

## Atualizar depois

- **Mudou o HTML:** suba o arquivo novo no S3 e crie uma invalidação `/*` no CloudFront
- **Mudou a Lambda:** `zip -j painel-sistemas-api.zip lambda/index.mjs lambda/package.json`
  e suba pelo console, ou:
  ```bash
  aws lambda update-function-code \
    --function-name painel-sistemas-api \
    --zip-file fileb://painel-sistemas-api.zip \
    --region sa-east-1
  ```
- **Trocou a chave da Nekt:** só a variável de ambiente. Nenhum deploy necessário.

---

## Custo

Para um painel interno com algumas dezenas de acessos por dia, isso roda dentro do
nível gratuito da AWS ou muito perto dele. A ordem de grandeza é de centavos de dólar
por mês — o S3 guarda um arquivo de 34 KB, a Lambda é chamada algumas centenas de
vezes, e o CloudFront serve alguns megabytes.

---

## O que mudou em relação à versão da Vercel

| | Vercel | AWS |
|---|---|---|
| Formato do handler | `export default (req, res)` | `export const handler = async (event)` |
| Resposta | `res.status(200).json(x)` | `{ statusCode, headers, body }` |
| Endereço da API no HTML | fixo em `/api/dados` | constante `API_URL`, trocável |
| CORS | desnecessário | opcional, via `ALLOWED_ORIGIN` |
| Cache | `s-maxage` | `max-age`, lido pelo CloudFront |
| Chave da Nekt | `process.env.NEKT_API_KEY` | **igual** |

A consulta SQL é byte a byte a mesma da versão que está funcionando hoje.
