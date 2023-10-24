import Fastify from 'fastify'
import fastifyStatic from '@fastify/static'
import path from 'path'
import 'dotenv/config'
import { initializeApp, cert } from 'firebase-admin/app'
import { getAuth } from 'firebase-admin/auth';
import { FieldValue, getFirestore } from "firebase-admin/firestore";

const fastify = Fastify()

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

fastify.get('/', function (request, reply) {
  reply.send({ message: "You have to login at https://dl.ja1ykl.com" })
})

fastify.get('/game/info', function (request, reply) {
  reply.sendFile('info.json')
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
        db.collection("serialCodes").doc(doc.id).update({
          call: FieldValue.increment(1)
        })
      });
    })
    reply.sendFile(`games/${gameId}-${os}-latest.zip`)
  }
})

fastify.listen({ port: 3344 }, function (err, address) {
  if (err) {
    fastify.log.error(err)
    process.exit(1)
  }
})
