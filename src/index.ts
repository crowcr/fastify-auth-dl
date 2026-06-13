import Fastify from 'fastify'
import fastifyCors from '@fastify/cors'
import 'dotenv/config'
import { initializeApp, cert } from 'firebase-admin/app'
import { getAuth } from 'firebase-admin/auth';
import { FieldValue, getFirestore } from "firebase-admin/firestore";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
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

const s3Client = new S3Client({
  region: "auto",
  endpoint: process.env.R2_ENDPOINT,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID || "",
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY || "",
  },
});

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

async function generateSerialCodes(gameId: string, count: number): Promise<string[]> {
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

  return generatedCodes;
}

fastify.post<{
  Body: {
    game_id: string
    count?: number
  }
}>('/game/genkey', async function (request, reply) {
  const adminApiKey = process.env.ADMIN_API_KEY;
  if (!adminApiKey) {
    return reply.code(500).send({ error: 'ADMIN_API_KEY environment variable is not set on the server.' });
  }

  const apiKey = request.headers['x-api-key'] || request.headers['authorization']?.toString().replace(/^Bearer\s+/i, '');
  if (apiKey !== adminApiKey) {
    return reply.code(401).send({ error: 'Unauthorized' });
  }

  const gameId = request.body?.game_id;
  const count = request.body?.count ?? 1;

  if (!gameId || typeof gameId !== 'string') {
    return reply.code(400).send({ error: 'game_id is required and must be a string.' });
  }

  if (typeof count !== 'number' || count <= 0 || count > 100) {
    return reply.code(400).send({ error: 'Count must be a number between 1 and 100.' });
  }

  // Check if game exists
  const gameDoc = await db.collection("games").doc(gameId).get();
  if (!gameDoc.exists) {
    return reply.code(404).send({ error: `Game '${gameId}' not found.` });
  }

  const generatedCodes = await generateSerialCodes(gameId, count);
  reply.send({ keys: generatedCodes });
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

  try {
    const verifyRes = await getAuth().verifyIdToken(accessToken);
    const isAdmin = !!verifyRes.admin;

    let hasLicense = isAdmin;
    const updatePromises: Promise<any>[] = [];

    if (!isAdmin) {
      const serialCodesRef = db.collection("serialCodes").where("userId", "==", verifyRes.user_id);
      const querySnapshot = await serialCodesRef.get();

      if (!querySnapshot.empty) {
        querySnapshot.forEach((doc) => {
          if (gameId === doc.data().game) {
            hasLicense = true;
            updatePromises.push(
              db.collection("serialCodes").doc(doc.id).update({
                call: FieldValue.increment(1)
              })
            );
          }
        });
      } else {
        return reply.code(404)
          .header('Content-Type', 'application/json; charset=utf-8')
          .send({ error: 'License Not Found' });
      }
    }

    if (!hasLicense) {
      return reply.code(403)
        .header('Content-Type', 'application/json; charset=utf-8')
        .send({ error: 'This license does not include specified game.' });
    }

    if (updatePromises.length > 0) {
      await Promise.all(updatePromises);
    }

    // Cloudflare R2 から署名付きURLを生成
    const ext = os === "mac" ? "dmg" : "zip";
    const fileKey = `games/${gameId}-${os}-latest.${ext}`;

    const command = new GetObjectCommand({
      Bucket: process.env.R2_BUCKET_NAME,
      Key: fileKey,
    });

    const signedUrl = await getSignedUrl(s3Client, command, { expiresIn: 300 });
    return reply.redirect(signedUrl);
  } catch (error) {
    fastify.log.error(error);
    return reply.code(500)
      .header('Content-Type', 'application/json; charset=utf-8')
      .send({ error: 'Internal Server Error' });
  }
})

fastify.listen({ port: 3344 }, function (err, address) {
  if (err) {
    fastify.log.error(err)
    process.exit(1)
  }
})
