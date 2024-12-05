import express from 'express';
import cors from 'cors';
import { initializeApp } from 'firebase-admin/app'; // Puedes usar esto si sigues con import, pero...
import admin from 'firebase-admin';  // Aquí necesitas `require` para Firebase
import { MercadoPagoConfig, Preference, Payment } from 'mercadopago';
import * as dotenv from 'dotenv';
import { readFileSync } from 'fs';
// import googleCredentials from '../utils/encuentro-8913c-4e5bb6a676e0.json' assert { type: 'json' }; 
// Cargar variables de entorno
dotenv.config();

const serviceAccount = JSON.parse(readFileSync('/etc/secrets/encuentro-8913c-4e5bb6a676e0.json', 'utf-8'));

// Inicializar Firebase Admin SDK
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const firestore = admin.firestore();

// SDK de Mercado Pago
const client = new MercadoPagoConfig({ 
  accessToken: process.env.MERCADOPAGO_ACCESS_TOKEN
});

const app = express();
const corsOptions = {
  origin: '*', // Cambia esto por el dominio permitido o usa '*' para todos.
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true // Permite incluir cookies si es necesario
};

app.options('*', cors(corsOptions));  // Permitir CORS en las solicitudes preflight
app.use(cors(corsOptions)); // Habilita CORS con opciones
app.use(express.json());

// Ruta para crear la preferencia de pago
app.post('/create_preference', async (req, res) => {
  res.header('Access-Control-Allow-Origin', 'https://puntoencuentro1-3.vercel.app');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  const { serviceId,auctionId, winningUserId, currentWinningPrice } = req.body;
  try {
    // Obtener la subasta de Firestore
 const auctionRef = firestore.collection('subastas').doc(auctionId);
const auctionDoc = await auctionRef.get({ source: 'server' });

console.log(auctionDoc.data())

const auctionData = auctionDoc.data();
console.log('Auction data:', auctionData);  // Imprime los datos completos del documento

if (!auctionData || !auctionData.winningUserId) {
  console.log(`Missing 'winningUserId' in document data`);
  return res.status(400).json({ error: 'Auction data is incomplete or missing winningUserId' });
}

if (!auctionDoc.exists) {
  console.log(`Auction with ID ${auctionId} does not exist in Firestore.`);
  return res.status(404).json({ error: 'Auction not found' });
} else {
  console.log('Auction found:', auctionDoc.id);
  console.log('Auction data:', auctionDoc.data());
}


const auction = auctionDoc.data();

    // Verificar si la subasta ya fue pagada
    if (auction.isPaid) {
      return res.status(400).json({ error: 'Auction has already been paid' });
    }

    const preference = new Preference(client);

    const result = await preference.create({
      body: {
        items: [
          {
            id: auctionId,
            title: `Ganador de la subasta`,
            quantity: 1,
            unit_price: currentWinningPrice,
          },
        ],
        back_urls: {
          success: 'https://puntoencuentro1-3.vercel.app/perfil/subastas',
          failure: 'https://puntoencuentro1-3.vercel.app/perfil/',
        },
        auto_return: 'approved',
        notification_url: 'https://backnodemp.onrender.com/payment_success',
        external_reference: winningUserId,
        metadata: {
          userId: winningUserId
        }
      }
    });

    return res.json(result);
  } catch (error) {
    console.error('Error creating preference:', error);
    return res.status(500).json({ error: 'Failed to create preference' });
  }
});



app.post('/payment_success', async (req, res) => {
  try {
    const { type, data } = req.body;

    // Verifica si el cuerpo tiene el formato esperado
    if (!data || !data.id) {
      console.error("Invalid webhook payload: Missing 'data.id'");
      return res.status(400).json({ error: "Invalid webhook payload: Missing 'data.id'" });
    }

    const paymentId = data.id;

    console.log("Payment ID received from webhook: ", paymentId);
    console.log("Notification type: ", type);

    // Verifica si la notificación es del tipo "payment"
    if (type !== "payment") {
      console.warn(`Unhandled notification type: ${type}`);
      return res.status(400).json({ error: `Unhandled notification type: ${type}` });
    }

    // Verifica que las credenciales de MercadoPago estén configuradas correctamente
    if (!payment) {
      console.error("MercadoPago SDK not initialized");
      return res.status(500).json({ error: "Internal server error: MercadoPago SDK not initialized" });
    }

    let paymentInfo;
    try {
      // Realiza el get del pago usando el ID recibido
      paymentInfo = await payment.get({ id: paymentId });
      console.log("Payment Info: ", JSON.stringify(paymentInfo, null, 2));
    } catch (error) {
      console.error("Error fetching payment info: ", error);
      return res.status(500).json({ error: "Error fetching payment info" });
    }

    // Verifica que el pago esté aprobado
    if (!paymentInfo || paymentInfo.status !== "approved") {
      console.error("Payment not approved or not found");
      return res.status(400).json({ error: "Payment not approved or not found" });
    }

    const { external_reference, transaction_amount, payer } = paymentInfo;

    if (!external_reference) {
      console.error("No external reference found in payment info");
      return res.status(400).json({ error: "No external reference found in payment info" });
    }

    console.log("External reference (winningUserId): ", external_reference);

    // Consulta en la colección de subastas
    const auctionQuery = await firestore
      .collection("subastas")
      .where("winningUserId", "==", external_reference)
      .where("isPaid", "==", false) // Asegura que la subasta no esté pagada
      .get();

    if (auctionQuery.empty) {
      console.error(`No pending auction found for winningUserId: ${external_reference}`);
      return res.status(404).json({ error: "No pending auction found" });
    }

    // Toma la primera subasta encontrada
    const auctionDoc = auctionQuery.docs[0];
    const auctionData = auctionDoc.data();
    const { serviceId } = auctionData; // Extrae serviceId de la subasta
    const auctionRef = auctionDoc.ref;

    console.log(`Auction ID: ${auctionDoc.id}, Service ID: ${serviceId}`);

    // Actualiza la subasta con información del pago
    await auctionRef.update({
      isPaid: true,
      paymentDate: new Date(),
      status: "completed",
      paidAmount: transaction_amount,
      payerEmail: payer?.email || null,
    });

    // Consulta y actualiza el servicio relacionado
    const serviceRef = firestore.collection("services").doc(serviceId);
    await serviceRef.update({
      subastaWinner: true,
    });

    console.log(`Service successfully updated in Firestore: ${serviceRef.id}`);

    return res.status(200).json({ message: "Payment processed successfully" });
  } catch (error) {
    console.error("Error handling payment webhook: ", error);
    return res.status(500).json({ error: "Internal server error" });
  }
});


// Iniciar el servidor
app.listen(process.env.PORT || 3333, () => {
  console.log("HTTP server running on port:", process.env.PORT || 3333);
});
