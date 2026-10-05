// Painel de Sistemas — Vila Brasil
// Função Lambda que consulta o data warehouse da Nekt e devolve o DB_SISTEMA em JSON.
//
// Runtime: Node.js 20.x ou superior (usa fetch e AbortSignal.timeout nativos).
// Integração: API Gateway HTTP API, payload format 2.0.
//
// A CHAVE DA NEKT NUNCA FICA NESTE ARQUIVO.
// Ela é lida de process.env.NEKT_API_KEY, definida nas variáveis de ambiente
// da função Lambda (console da AWS → Configuration → Environment variables).
// Assim ela não entra no repositório, não entra no .zip do deploy e pode ser
// trocada sem publicar código novo.

const NEKT_URL = 'https://api.nekt.ai/api/v1/sql-query/';

const SQL = `
WITH base AS (
  SELECT
    TRIM((SELECT f.native_value FROM UNNEST(r.record_fields) f WHERE f.name='Sistema ' LIMIT 1)) AS sistema,
    TRIM((SELECT f.native_value FROM UNNEST(r.record_fields) f WHERE f.name='Razão Social' LIMIT 1)) AS fornecedor,
    TRIM((SELECT f.native_value FROM UNNEST(r.record_fields) f WHERE f.name='ÁREA' LIMIT 1)) AS area,
    TRIM((SELECT f.native_value FROM UNNEST(r.record_fields) f WHERE f.name='Centro de Custo' LIMIT 1)) AS centro_custo,
    TRIM((SELECT f.native_value FROM UNNEST(r.record_fields) f WHERE f.name='ORIGEM PAGAMENTO' LIMIT 1)) AS origem,
    IFNULL(TRIM((SELECT f.native_value FROM UNNEST(r.record_fields) f WHERE f.name='Forma de Cobrança ' LIMIT 1)),'—') AS forma,
    IFNULL((SELECT SAFE_CAST(f.native_value AS FLOAT64) FROM UNNEST(r.record_fields) f WHERE f.name='Mensaliade' LIMIT 1),0) AS mensal,
    IFNULL((SELECT SAFE_CAST(f.native_value AS FLOAT64) FROM UNNEST(r.record_fields) f WHERE f.name='Valor Setup' LIMIT 1),0) AS setup,
    (SELECT SAFE_CAST(f.native_value AS INT64) FROM UNNEST(r.record_fields) f WHERE f.name='Quantidade de Licenças Contratadas' LIMIT 1) AS lic_c,
    (SELECT SAFE_CAST(f.native_value AS INT64) FROM UNNEST(r.record_fields) f WHERE f.name='Quantidade de Licenças Utilizadas' LIMIT 1) AS lic_u,
    (SELECT INITCAP(LOWER(TRIM(f.native_value)))
     FROM UNNEST(r.record_fields) f
     WHERE UPPER(TRIM(f.name)) = 'PERIODICIDADE' LIMIT 1) AS periodicidade,
    (SELECT COALESCE(
        SAFE_CAST(f.native_value AS DATE),
        SAFE_CAST(SAFE_CAST(f.native_value AS TIMESTAMP) AS DATE),
        SAFE.PARSE_DATE('%d/%m/%Y', f.value))
     FROM UNNEST(r.record_fields) f WHERE f.name='Data de Cancelamento' LIMIT 1) AS data_cancelamento,
    SUBSTR(REGEXP_REPLACE(IFNULL(TRIM((SELECT f.native_value FROM UNNEST(r.record_fields) f WHERE f.name='Descrição ' LIMIT 1)),''), r'\\s+',' '),0,400) AS obs
  FROM \`inovacoes_tecnologicas_raw.pipefy_table_records_307310066\` r
)
SELECT TO_BASE64(CAST(TO_JSON_STRING(STRUCT(
  FORMAT_TIMESTAMP('%d/%m/%Y às %H:%M', CURRENT_TIMESTAMP(), 'America/Sao_Paulo') AS atualizado_em,
  CURRENT_DATE('America/Sao_Paulo') AS hoje,
  ARRAY_AGG(STRUCT(sistema,fornecedor,area,centro_custo,origem,forma,mensal,setup,lic_c,lic_u,periodicidade,data_cancelamento,obs) ORDER BY mensal DESC) AS linhas
)) AS BYTES)) AS payload
FROM base`;

// Origem autorizada a chamar esta API pelo navegador.
// Se o site e a API ficarem atrás do mesmo CloudFront, não há CORS e esta
// variável pode ficar em branco. Se o site estiver num domínio diferente da
// API, defina ALLOWED_ORIGIN com a URL exata do site (ex.: https://painel.vilabr.com.br).
const ORIGEM = process.env.ALLOWED_ORIGIN || '';

function responder(status, corpo, cacheControl) {
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': cacheControl,
    'X-Content-Type-Options': 'nosniff',
  };
  if (ORIGEM) {
    headers['Access-Control-Allow-Origin'] = ORIGEM;
    headers['Vary'] = 'Origin';
  }
  return { statusCode: status, headers, body: JSON.stringify(corpo) };
}

const erro = (msg) => responder(502, { erro: msg }, 'no-store');

export const handler = async (event) => {
  // Preflight do CORS, caso o site esteja em outro domínio.
  const metodo = event?.requestContext?.http?.method || event?.httpMethod || 'GET';
  if (metodo === 'OPTIONS') {
    return {
      statusCode: 204,
      headers: {
        'Access-Control-Allow-Origin': ORIGEM || '*',
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
        'Access-Control-Allow-Headers': 'Accept, Content-Type',
        'Access-Control-Max-Age': '86400',
      },
      body: '',
    };
  }

  const chave = process.env.NEKT_API_KEY;
  if (!chave) {
    return responder(500, {
      erro: 'A variável de ambiente NEKT_API_KEY não está configurada na função Lambda.',
    }, 'no-store');
  }

  try {
    const r = await fetch(NEKT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': chave },
      body: JSON.stringify({ sql: SQL, mode: 'csv' }),
      signal: AbortSignal.timeout(25000),
    });

    if (!r.ok) {
      const txt = (await r.text()).slice(0, 300);
      return erro(`A Nekt recusou a consulta (HTTP ${r.status}). ${txt}`);
    }

    const resposta = await r.json();
    if (resposta.state && resposta.state !== 'SUCCEEDED') {
      return erro(`A consulta terminou em estado ${resposta.state}.`);
    }

    const url = (resposta.presigned_urls || [])[0];
    if (!url) return erro('A Nekt não devolveu o link do resultado.');

    const csv = await (await fetch(url, { signal: AbortSignal.timeout(25000) })).text();

    // O resultado é uma linha só, com uma coluna de base64 — sem vírgulas nem aspas dentro.
    const celula = csv.split('\n')[1]?.trim().replace(/^"|"$/g, '');
    if (!celula) return erro('O resultado veio vazio.');

    const dados = JSON.parse(Buffer.from(celula, 'base64').toString('utf8'));

    // Tabela vazia na Nekt faz o ARRAY_AGG devolver null. Isso NÃO é sucesso:
    // sem esta barreira a resposta vazia entraria no cache do CloudFront e
    // continuaria sendo servida por horas depois de a Nekt voltar ao normal.
    if (!Array.isArray(dados?.linhas) || dados.linhas.length === 0) {
      return erro(
        'A tabela DB_SISTEMA na Nekt respondeu sem nenhum registro. '
        + 'A consulta e a chave estão funcionando — o que faltou foi o dado. '
        + 'Rode o conector do Pipefy na Nekt e recarregue esta página.'
      );
    }

    // 10 min de frescor; por até 24 h o CloudFront continua servindo a última
    // resposta boa se a Nekt cair, em vez de mostrar erro.
    return responder(200, dados, 'public, max-age=600, stale-while-revalidate=86400');

  } catch (e) {
    const msg = e.name === 'TimeoutError'
      ? 'A Nekt demorou demais para responder.'
      : String(e.message || e);
    return erro(msg);
  }
};
