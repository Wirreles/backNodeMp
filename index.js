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

if (!auctionData || typeof auctionData.winningUserId === 'undefined') {
  console.log(`'winningUserId' is missing in the document.`);
  return res.status(400).json({ error: `'winningUserId' is missing in auction data.` });
}

if (!auctionDoc.exists) {
  console.log(`Auction with ID ${auctionId} does not exist in Firestore.`);
  return res.status(404).json({ error: 'Auction not found' });
} else {
  console.log('Auction found:', auctionDoc.id);
  console.log('Auction data:', auctionDoc.data());
}

if (!auctionDoc.exists) {
  console.log(`Auction with ID ${auctionId} does not exist in Firestore.`);
  return res.status(404).json({ error: 'Auction not found' });
}



if (!auctionData || !auctionData.winningUserId) {
  console.log(`Missing 'winningUserId' in document data`);
  return res.status(400).json({ error: 'Auction data is incomplete or missing winningUserId' });
}
    

    // if (!auctionDoc.exists) {
    //   return res.status(404).json({ error: 'Auction not found' });
    // }

    const auction = auctionDoc.data();

    // Validar si el usuario es el ganador actual de la subasta
    if (auction.winningUserId !== winningUserId) {
      return res.status(400).json({ error: 'User is not the current winner of the auction' });
    }

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
        // notification_url: 'https://3745-2803-9800-b8ca-80aa-8963-96e5-33ae-8ef7.ngrok-free.app/payment_success',
        notification_url: 'https://2b3gbb4p-3300.brs.devtunnels.ms/payment_success',
        
      }
    });

    // Inspeccionar la estructura del resultado
    console.log('Result:', result);

    // Guardar datos temporales en Firestore
    const tempData = {
      userId: winningUserId,
      serviceId: serviceId,
      auctionId: auctionId,
      paymentAmount: currentWinningPrice,
      preferenceId: result?.body?.id || result?.id, // Intenta acceder a result.body.id y result.id
      status: 'pending',
    };

    if (!tempData.preferenceId) {
      throw new Error('Preference ID is undefined');
    }

    await firestore.collection('tempStorage').add(tempData);

    return res.json(result);
  } catch (error) {
    console.error('Error creating preference:', error);
    return res.status(500).json({ error: 'Failed to create preference' });
  }
});



// Ruta para manejar el pago exitoso
app.post('/payment_success', async (req, res) => {
  const dataId = req.query['data.id'];  // Tomamos el ID desde la query
  const type1 = req.query['type'];
  console.log(dataId, type1);

  if (type1 === 'payment') {
    try {
      // Buscar el pago en Mercado Pago usando el ID
      const payment = new Payment(client);
      const response = await payment.search(dataId);

      if (!response || !response.results || response.results.length === 0) {
        return res.status(404).json({ error: 'Payment not found' });
      }

      // Recuperar el primer documento en la colección tempStorage
      const tempDataSnap = await firestore.collection('tempStorage').limit(1).get();

      if (tempDataSnap.empty) {
        return res.status(404).json({ error: 'No temp data found' });
      }

      // Como solo esperamos un documento, accedemos al primer resultado
      const tempDoc = tempDataSnap.docs[0];
      const tempData = tempDoc.data();

      const { serviceId,auctionId, paymentAmount } = tempData;

      // Actualizar los campos de la subasta en Firestore usando auctionId
      const auctionRef = firestore.collection('subastas').doc(auctionId);
      await auctionRef.update({
        isPaid: true,
        paidAmount: paymentAmount,
      });

      const serviceRef = firestore.collection('services').doc(serviceId)
      await serviceRef.update({
        subastaWinner: true
      })
      
      // Eliminar el documento temporal después de procesar el pago
      await firestore.collection('tempStorage').doc(tempDoc.id).delete();

      return res.status(200).json({ message: 'Payment processed successfully' });
    } catch (error) {
      console.error('Failed to process payment:', error);
      return res.status(500).json({ error: 'Failed to process payment' });
    }
  } else {
    return res.status(400).json({ error: 'Invalid payment type' });
  }
});

// Iniciar el servidor
app.listen(process.env.PORT || 3333, () => {
  console.log("HTTP server running on port:", process.env.PORT || 3333);
});
