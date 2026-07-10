const express = require('express');
const cors = require('cors');
const { initializeApp, cert, getApps } = require('firebase-admin/app');
const { getStorage } = require('firebase-admin/storage');
const { execSync } = require('child_process');
const os = require('os');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

const app = express();
app.use(cors());
app.use(express.json());

// Inicializa Firebase Admin com a conta de serviço padrão do Cloud Run
if (!getApps().length) {
  initializeApp();
}

// ─────────────────────────────────────────────────────────────
// ROTA: POST /compress
// Chamada pelo frontend (callable) para PDFs < 10MB
//
// Body esperado:
// {
//   "storagePath": "provas/clienteId/arquivo.pdf",
//   "bucketName": "datisprev.firebasestorage.app"
// }
// ─────────────────────────────────────────────────────────────
app.post('/compress', async (req, res) => {
  const { storagePath, bucketName } = req.body;

  if (!storagePath || !bucketName) {
    return res.status(400).json({ error: 'storagePath e bucketName são obrigatórios.' });
  }

  // Validação de segurança: só aceita caminhos em /provas/
  if (!storagePath.startsWith('provas/')) {
    return res.status(403).json({ error: 'Acesso negado.' });
  }

  try {
    const resultado = await comprimirPdf(storagePath, storagePath, bucketName);
    return res.json(resultado);
  } catch (err) {
    console.error('Erro ao comprimir:', err);
    return res.status(500).json({ error: 'Erro interno ao comprimir PDF.' });
  }
});

// ─────────────────────────────────────────────────────────────
// ROTA: POST /compress-upload
// Recebe o PDF bruto (multipart), comprime e devolve o binário.
// Usado pelo frontend ANTES de salvar no Storage (PDFs < 10MB).
// ─────────────────────────────────────────────────────────────
app.post('/compress-upload', upload.single('file'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'Nenhum arquivo enviado.' });
  }

  const tempDir = os.tmpdir();
  const ts = Date.now();
  const inputPath = path.join(tempDir, `in_${ts}.pdf`);
  const outputPath = path.join(tempDir, `out_${ts}.pdf`);

  try {
    fs.writeFileSync(inputPath, req.file.buffer);
    const tamanhoOriginal = req.file.buffer.length;

    const cmd = [
      'gs',
      '-sDEVICE=pdfwrite',
      '-dCompatibilityLevel=1.4',
      '-dPDFSETTINGS=/ebook',
      '-dNOPAUSE',
      '-dQUIET',
      '-dBATCH',
      `-sOutputFile=${outputPath}`,
      inputPath,
    ].join(' ');

    let bufferFinal = req.file.buffer;
    let comprimido = false;
    let reducaoPercent = 0;

    try {
      execSync(cmd, { timeout: 120000 });
      const tamanhoFinal = fs.statSync(outputPath).size;

      if (tamanhoFinal < tamanhoOriginal) {
        bufferFinal = fs.readFileSync(outputPath);
        comprimido = true;
        reducaoPercent = Math.round(((tamanhoOriginal - tamanhoFinal) / tamanhoOriginal) * 100);
      }
    } catch (e) {
      console.warn('Ghostscript falhou, retornando original:', e.message);
    }

    res.set('Content-Type', 'application/pdf');
    res.set('X-Comprimido', String(comprimido));
    res.set('X-Reducao-Percent', String(reducaoPercent));
    res.set('X-Tamanho-Original', String(tamanhoOriginal));
    return res.send(bufferFinal);

  } catch (err) {
    console.error('Erro em /compress-upload:', err);
    return res.status(500).json({ error: 'Erro interno ao comprimir PDF.' });
  } finally {
    if (fs.existsSync(inputPath)) fs.unlinkSync(inputPath);
    if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
  }
});

// ─────────────────────────────────────────────────────────────
// ROTA: POST /handleStorageEvent
// Chamada pelo Eventarc (trigger) para PDFs > 10MB
// O evento vem automaticamente quando arquivo é salvo em /temp/
// ─────────────────────────────────────────────────────────────
app.post('/handleStorageEvent', async (req, res) => {
  const data = req.body;
  const filePath = data?.name;
  const bucketName = data?.bucket;

  if (!filePath || !bucketName) {
    return res.status(400).json({ error: 'Evento inválido.' });
  }

  // Só processa arquivos em /temp/ com extensão .pdf
  if (!filePath.startsWith('temp/') || !filePath.endsWith('.pdf')) {
    return res.status(200).json({ message: 'Ignorado.' });
  }

  // Define o caminho definitivo: temp/ → provas/
  const destinoPath = filePath.replace('temp/', 'provas/');

  try {
    await comprimirPdf(filePath, destinoPath, bucketName);

    // Remove o arquivo temporário após processar
    try {
      await getStorage().bucket(bucketName).file(filePath).delete();
    } catch (e) {
      console.warn('Erro ao deletar temp:', e);
    }

    return res.json({ message: 'Comprimido com sucesso.' });
  } catch (err) {
    console.error('Erro no trigger:', err);
    return res.status(500).json({ error: 'Erro ao processar evento.' });
  }
});

// ─────────────────────────────────────────────────────────────
// FUNÇÃO COMPARTILHADA — lógica de compressão com Ghostscript
// ─────────────────────────────────────────────────────────────
async function comprimirPdf(origemPath, destinoPath, bucketName) {
  const bucket = getStorage().bucket(bucketName);
  const tempDir = os.tmpdir();
  const ts = Date.now();
  const inputPath = path.join(tempDir, `in_${ts}.pdf`);
  const outputPath = path.join(tempDir, `out_${ts}.pdf`);

  try {
    // 1. Baixar arquivo do Storage
    await bucket.file(origemPath).download({ destination: inputPath });
    const tamanhoOriginal = fs.statSync(inputPath).size;

    // 2. Comprimir com Ghostscript
    // /ebook = 150 DPI — bom equilíbrio para documentos jurídicos
    const cmd = [
      'gs',
      '-sDEVICE=pdfwrite',
      '-dCompatibilityLevel=1.4',
      '-dPDFSETTINGS=/ebook',
      '-dNOPAUSE',
      '-dQUIET',
      '-dBATCH',
      `-sOutputFile=${outputPath}`,
      inputPath,
    ].join(' ');

    try {
      execSync(cmd, { timeout: 240000 });
    } catch (e) {
      console.warn('Ghostscript falhou, usando original:', e.message);
      // Se Ghostscript falhar, salva o original no destino
      await bucket.upload(inputPath, {
        destination: destinoPath,
        metadata: { contentType: 'application/pdf' },
      });
      return { comprimido: false, reducaoPercent: 0, tamanhoOriginal, tamanhoFinal: tamanhoOriginal };
    }

    const tamanhoFinal = fs.statSync(outputPath).size;

    // 3. Só substitui se ficou menor
    const arquivoParaSalvar = tamanhoFinal < tamanhoOriginal ? outputPath : inputPath;
    const comprimido = tamanhoFinal < tamanhoOriginal;
    const reducaoPercent = comprimido
      ? Math.round(((tamanhoOriginal - tamanhoFinal) / tamanhoOriginal) * 100)
      : 0;

    // 4. Salvar no destino definitivo
    await bucket.upload(arquivoParaSalvar, {
      destination: destinoPath,
      metadata: {
        contentType: 'application/pdf',
        metadata: {
          comprimido: String(comprimido),
          tamanhoOriginal: String(tamanhoOriginal),
          tamanhoFinal: String(comprimido ? tamanhoFinal : tamanhoOriginal),
        },
      },
    });

    console.log(`PDF processado: ${reducaoPercent}% de redução`);
    return { comprimido, reducaoPercent, tamanhoOriginal, tamanhoFinal: comprimido ? tamanhoFinal : tamanhoOriginal };

  } finally {
    // 5. Limpar arquivos temporários sempre
    if (fs.existsSync(inputPath)) fs.unlinkSync(inputPath);
    if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
  }
}

// ─────────────────────────────────────────────────────────────
// HEALTH CHECK
// ─────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'pdf-compress-service' });
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`pdf-compress-service rodando na porta ${PORT}`);
});