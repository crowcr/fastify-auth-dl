import Fastify from 'fastify'
import fastifyCors from '@fastify/cors'
import 'dotenv/config'
import { initializeApp, cert } from 'firebase-admin/app'
import { getAuth } from 'firebase-admin/auth';
import { FieldValue, getFirestore } from "firebase-admin/firestore";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";


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
    const serialCodesRef = db.collection("serialCodes").where("userId", "==", verifyRes.user_id);
    const querySnapshot = await serialCodesRef.get();

    if (!querySnapshot.empty) {
      let hasLicense = false;
      const updatePromises: Promise<any>[] = [];

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

      if (!hasLicense) {
        return reply.code(403)
          .header('Content-Type', 'application/json; charset=utf-8')
          .send({ error: 'This license does not include specified game.' });
      }

      await Promise.all(updatePromises);

      // Cloudflare R2 から署名付きURLを生成
      const ext = os === "mac" ? "dmg" : "zip";
      const fileKey = `games/${gameId}-${os}-latest.${ext}`;

      const command = new GetObjectCommand({
        Bucket: process.env.R2_BUCKET_NAME,
        Key: fileKey,
      });

      const signedUrl = await getSignedUrl(s3Client, command, { expiresIn: 300 });
      return reply.redirect(signedUrl);
    } else {
      return reply.code(404)
        .header('Content-Type', 'application/json; charset=utf-8')
        .send({ error: 'License Not Found' });
    }
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
