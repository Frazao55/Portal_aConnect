# IA Interview MVP

Aplicacao local em Node/Express para reconhecimento facial e entrevista por voz com a OpenAI Realtime API.

## Requisitos

- Node.js
- Chave `OPENAI_API_KEY`
- Browser com permissao de microfone e WebRTC

## Configuracao

1. Instalar dependencias:

```bash
npm install
```

2. Criar `.env` a partir de `.env.example`:

```env
OPENAI_API_KEY=sk-...
PORT=3000
```

3. Em redes empresariais onde WebRTC falha, configurar TURN:

```env
TURN_URL=turns:teu-servidor-turn:5349
TURN_USERNAME=utilizador
TURN_CREDENTIAL=password
```

## Arranque

```bash
npm start
```

Depois abrir:

```text
http://localhost:3000
```

## Dados locais

A pasta `data/` guarda rostos, descritores e entrevistas geradas em runtime. Estes ficheiros nao devem ser enviados para Git porque podem conter dados pessoais.
