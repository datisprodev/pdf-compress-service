# pdf-compress-service

Microsserviço em Node.js/Express para compressão automática de PDFs, usando **Ghostscript**, integrado ao **Firebase Storage** do projeto [Datisprev](https://github.com/) e hospedado no **Google Cloud Run**.

## 📋 Visão geral

Esse serviço reduz o tamanho de PDFs enviados para o sistema Datisprev (documentação previdenciária), otimizando espaço de armazenamento e velocidade de download, sem perder legibilidade do documento.

A lógica é dividida em dois fluxos, de acordo com o tamanho do arquivo:

| Tamanho do arquivo | Fluxo | Rota |
|---|---|---|
| **< 10MB** | Síncrono — frontend chama a rota diretamente e aguarda o resultado | `POST /compress` |
| **> 10MB** | Assíncrono — frontend salva em `temp/`, e o Eventarc dispara o processamento automaticamente | `POST /handleStorageEvent` |

## 🚀 Stack

- **Node.js** + **Express**
- **Ghostscript** (compressão de PDF via `pdfwrite`, preset `/ebook`)
- **Firebase Admin SDK** (leitura/escrita no Cloud Storage)
- **Docker** (containerização customizada com Ghostscript instalado)
- **Google Cloud Run** (hospedagem serverless, região `southamerica-east1`)

## 📁 Estrutura

```
pdf-compress-service/
  ├── Dockerfile       # Imagem com Node.js + Ghostscript
  ├── package.json     # Dependências do projeto
  ├── index.js         # Lógica das rotas e compressão
  └── .gitignore
```

## 🔌 Endpoints

### `GET /`
Health check simples.

**Resposta:**
```json
{ "status": "ok", "service": "pdf-compress-service" }
```

### `POST /compress`
Comprime um PDF já salvo no bucket, sobrescrevendo o mesmo caminho.

**Body:**
```json
{
  "storagePath": "provas/clienteId/arquivo.pdf",
  "bucketName": "datisprev.firebasestorage.app"
}
```

**Resposta:**
```json
{
  "comprimido": true,
  "reducaoPercent": 29,
  "tamanhoOriginal": 117647,
  "tamanhoFinal": 83589
}
```

> ⚠️ Por segurança, só aceita caminhos que comecem com `provas/`.

### `POST /handleStorageEvent`
Disparado automaticamente pelo **Eventarc** quando um arquivo `.pdf` é salvo em `temp/`. Comprime e move o arquivo para `provas/`, removendo o temporário ao final.

**Body (enviado automaticamente pelo Eventarc):**
```json
{
  "name": "temp/clienteId/arquivo.pdf",
  "bucket": "datisprev.firebasestorage.app"
}
```

## ⚙️ Como funciona a compressão

O Ghostscript é executado com o preset `/ebook` (150 DPI), um equilíbrio entre qualidade e tamanho, adequado para documentos jurídicos/previdenciários:

```bash
gs -sDEVICE=pdfwrite -dCompatibilityLevel=1.4 -dPDFSETTINGS=/ebook \
   -dNOPAUSE -dQUIET -dBATCH -sOutputFile=saida.pdf entrada.pdf
```

Se a compressão não reduzir o tamanho (comum em PDFs já otimizados ou majoritariamente texto), o arquivo original é mantido — o serviço nunca salva uma versão maior que a original.

## 🖥️ Rodando localmente

```bash
npm install
npm start
```

> Requer Ghostscript instalado localmente (`gs` no PATH) e credenciais do Firebase configuradas (via `GOOGLE_APPLICATION_CREDENTIALS` ou ambiente autenticado).

## ☁️ Deploy no Cloud Run

```bash
gcloud run deploy pdf-compress-service \
  --source . \
  --region=southamerica-east1 \
  --allow-unauthenticated \
  --memory=512Mi \
  --timeout=120
```

**Por que `southamerica-east1`?** É a região do GCP mais próxima do Brasil (São Paulo), priorizando menor latência para os usuários do Datisprev.

**Por que `512Mi`?** Ponto de partida equilibrado para a maioria dos PDFs de documentos. Pode ser ajustado conforme a demanda:

```bash
gcloud run deploy pdf-compress-service \
  --source . \
  --region=southamerica-east1 \
  --allow-unauthenticated \
  --memory=1Gi \
  --timeout=120
```

## 📊 Monitoramento

Ver logs em tempo real:

```bash
gcloud run services logs read pdf-compress-service --region=southamerica-east1 --limit=50
```

Ver detalhes do serviço:

```bash
gcloud run services describe pdf-compress-service --region=southamerica-east1
```

Ou pelo console web: [console.cloud.google.com/run](https://console.cloud.google.com/run)

## 🔲 Pendências

- [ ] Configurar o **Eventarc trigger** no GCP para disparar `/handleStorageEvent` automaticamente quando arquivos caem em `temp/`
- [ ] Integrar a rota `/compress` no fluxo de upload do frontend Angular (Datisprev)

## 📄 Licença

Projeto privado — uso interno do sistema Datisprev.
