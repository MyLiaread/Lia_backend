// server.js
import express from "express";
import bodyParser from "body-parser";
import admin from "firebase-admin";
import fetch from "node-fetch";

// ---- Initialisation Firebase ----
import serviceAccount from "./serviceAccountKey.json" assert { type: "json" };

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});
const db = admin.firestore();

// ---- Express config ----
const app = express();
app.use(bodyParser.json());

// ---- Routes ----

// 1. Créer une transaction de paiement (FedaPay)
app.post("/api/pay", async (req, res) => {
  const { livre, auteurId, montant } = req.body;

  try {
    // Création transaction via FedaPay
    const fedapayRes = await fetch("https://api.fedapay.com/v1/transactions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.FEDAPAY_SECRET_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        amount: montant,
        description: `Achat du livre: ${livre}`,
        callback_url: `${process.env.BASE_URL}/api/fedapay/callback`,
      }),
    });

    const data = await fedapayRes.json();

    // Stocker la transaction dans Firestore
    await db.collection("ventes").doc(data.id.toString()).set({
      livre,
      auteurId,
      montant,
      status: "pending",
      fedapayId: data.id,
      createdAt: new Date(),
    });

    res.json({ payment_url: data.payment_url });
  } catch (error) {
    console.error("Erreur paiement:", error);
    res.status(500).json({ error: "Erreur création paiement" });
  }
});

// 2. Callback FedaPay (paiement validé ou échoué)
app.post("/api/fedapay/callback", async (req, res) => {
  try {
    const { id, status } = req.body; // Transaction ID + status (approved, canceled, etc.)
    const venteRef = db.collection("ventes").doc(id.toString());
    const venteSnap = await venteRef.get();

    if (!venteSnap.exists) {
      return res.status(404).json({ error: "Vente introuvable" });
    }

    const vente = venteSnap.data();

    if (status === "approved") {
      // Partage revenus
      const PART_AUTHOR = 0.7;
      const PART_ADMIN = 0.3;

      const montantAuteur = vente.montant * PART_AUTHOR;
      const montantAdmin = vente.montant * PART_ADMIN;

      const authorRef = db.collection("auteurs").doc(vente.auteurId);
      const adminRef = db.collection("admin").doc("global");

      await db.runTransaction(async (t) => {
        const authorSnap = await t.get(authorRef);
        const adminSnap = await t.get(adminRef);

        // Mettre à jour l’auteur
        t.update(authorRef, {
          revenus: (authorSnap.data()?.revenus || 0) + montantAuteur,
          ventes: (authorSnap.data()?.ventes || 0) + 1,
        });

        // Mettre à jour l’admin
        t.set(adminRef, {
          totalRevenus: (adminSnap.data()?.totalRevenus || 0) + montantAdmin,
        }, { merge: true });

        // Mettre à jour la vente
        t.update(venteRef, {
          status: "success",
          updatedAt: new Date(),
        });
      });

      console.log(`✅ Vente ${id} validée. Auteur +${montantAuteur}, Admin +${montantAdmin}`);
    } else {
      await venteRef.update({
        status: "failed",
        updatedAt: new Date(),
      });
      console.log(`❌ Vente ${id} échouée`);
    }

    res.sendStatus(200);
  } catch (error) {
    console.error("Erreur callback:", error);
    res.status(500).json({ error: "Erreur traitement callback" });
  }
});

// ---- Lancement serveur ----
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Backend lancé sur http://localhost:${PORT}`));
