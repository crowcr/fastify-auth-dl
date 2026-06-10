import Fastify from 'fastify'
import fastifyStatic from '@fastify/static'
import fastifyCors from '@fastify/cors'
import path from 'path'
import 'dotenv/config'
import { initializeApp, cert } from 'firebase-admin/app'
import { getAuth } from 'firebase-admin/auth';
import { FieldValue, getFirestore } from "firebase-admin/firestore";
import fs from "fs";
import crypto from "crypto";


interface Changelog {
  version: string;
  date: string;
  description: string;
}

interface Game {
  id: string;
  name: string;
  description: string;
  manual_url: string;
  image_url: string;
  latest: string;
  supported_os: string[];
  shop_url: string;
  changelog: Changelog[];
}

const fastify = Fastify({logger: true})

const certConfig = {
  projectId: process.env.FIREBASE_PROJECT_ID,
  clientEmail: process.env.FIREBASE_ADMIN_CLIENT_EMAIL,
  privateKey: process.env.FIREBASE_ADMIN_PRIVATE_KEY?.replace(/\\n/g, "\n"),
}

const app = initializeApp({
  credential: cert(certConfig),
});

const db = getFirestore();

fastify.register(fastifyStatic, {
  root: path.join(__dirname, '..', 'public'),
  prefix: '/public/',
  constraints: { host: 'files.ja1ykl.com' }
})

fastify.register(fastifyCors, {
  exposedHeaders: 'Content-Disposition'
})

fastify.get('/', function (request, reply) {
  reply.send({ message: "You have to login at https://dl.ja1ykl.com" })
})

fastify.get('/game/info', async function (request, reply) {
  const querySnapshot = await db.collection("games").get();
  const games: Game[] = [];
  querySnapshot.forEach((doc) => {
    const data = doc.data() as Omit<Game, 'id'>;
    games.push({
      id: doc.id,
      ...data
    });
  });
  reply.send(games);
})

fastify.post<{
  Params: {
    gameId: string
  }
  Body: {
    count?: number
  }
}>('/game/:gameId/serial', async function (request, reply) {
  const adminApiKey = process.env.ADMIN_API_KEY;
  if (!adminApiKey) {
    return reply.code(500).send({ error: 'ADMIN_API_KEY environment variable is not set on the server.' });
  }

  const apiKey = request.headers['x-api-key'] || request.headers['authorization']?.toString().replace(/^Bearer\s+/i, '');
  if (apiKey !== adminApiKey) {
    return reply.code(401).send({ error: 'Unauthorized' });
  }

  const { gameId } = request.params;
  const count = request.body?.count ?? 1;

  if (typeof count !== 'number' || count <= 0 || count > 100) {
    return reply.code(400).send({ error: 'Count must be a number between 1 and 100.' });
  }

  // Check if game exists
  const gameDoc = await db.collection("games").doc(gameId).get();
  if (!gameDoc.exists) {
    return reply.code(404).send({ error: `Game '${gameId}' not found.` });
  }

  const querySnapshot = await db.collection("serialCodes").get();
  const serialCodes = querySnapshot.docs.map((doc) => doc.data().serialCode);
  const localSerialCodes = [...serialCodes];

  const generatedCodes: string[] = [];
  const S = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

  for (let i = 0; i < count; i++) {
    let serialCode = "";
    while (true) {
      let tempCode = "";
      for (let j = 0; j < 4; j++) {
        const randomBytes = crypto.randomBytes(4);
        tempCode += Array.from(randomBytes)
          .map((n) => S[n % S.length])
          .join("");
        if (j < 3) {
          tempCode += "-";
        }
      }
      if (!localSerialCodes.includes(tempCode)) {
        serialCode = tempCode;
        break;
      }
    }
    localSerialCodes.push(serialCode);
    generatedCodes.push(serialCode);

    const docId = crypto.createHash("md5").update(serialCode).digest("hex");
    await db.collection("serialCodes").doc(docId).set({
      call: 0,
      serialCode: serialCode,
      game: gameId,
      userId: docId,
    });
  }

  reply.send({ serialCodes: generatedCodes });
})

fastify.get<{
  Querystring: {
    os: string
    accessToken: string
  }
  Params: {
    gameId: string
  }
}>('/game/:gameId/dl', async function (request, reply) {
  const { gameId } = request.params;
  const { os, accessToken } = request.query;
    const verifyRes = await getAuth()
      .verifyIdToken(accessToken)
    const querySnapshot = await db.collection("serialCodes").where("userId", "==", verifyRes.user_id);
    if (querySnapshot) {
      querySnapshot.get().then((querySnapshot) => {
        querySnapshot.forEach((doc) => {
          if (gameId === doc.data().game) {
            db.collection("serialCodes").doc(doc.id).update({
              call: FieldValue.increment(1)
            })
          } else {
            reply.code(403)
              .header('Content-Type', 'application/json; charset=utf-8')
              .send({ error: 'This license does not include specified game.' })
          }
        });
      })
      const currentDir = process.cwd()
      if (os === "mac") {
        const stream = fs.readFileSync(path.join(currentDir, `public/games/${gameId}-${os}-latest.dmg`))
        reply.header('Content-disposition', 'attachment; filename=' + `${gameId}-${os}-latest.dmg`).send(stream)
      } else {
        const stream = fs.readFileSync(path.join(currentDir, `public/games/${gameId}-${os}-latest.zip`))
        reply.header('Content-disposition', 'attachment; filename=' + `${gameId}-${os}-latest.zip`).send(stream)
      }
    } else {
      reply.code(404)
        .header('Content-Type', 'application/json; charset=utf-8')
        .send({ error: 'License Not Found' })
    }
})

fastify.listen({ port: 3344 }, function (err, address) {
  if (err) {
    fastify.log.error(err)
    process.exit(1)
  }
})
