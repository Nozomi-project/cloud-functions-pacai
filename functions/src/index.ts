import * as functions from "firebase-functions";
import * as admin from "firebase-admin";
import {CloudTasksClient} from "@google-cloud/tasks";
admin.initializeApp();

export const onCreateReservation =
functions.firestore
    .document("reservation/{reservationId}")
    .onCreate(async (snapshot) => {
      const expiresAt = snapshot.data().expiration_date;
      let expirationAtSeconds: number | undefined;
      if (expiresAt) {
        expirationAtSeconds = expiresAt.seconds;
      }
      if (!expirationAtSeconds) {
        return;
      }

      const project = JSON.parse(process.env.FIREBASE_CONFIG!).projectId;
      const location = "us-central1";
      const queue = "firestore-ttl";

      const tasksClient = new CloudTasksClient();
      const queuePath: string = tasksClient.queuePath(project, location, queue);

      const url = `https://${location}-${project}.cloudfunctions.net/firestoreTtlCallback`;
      const docPath = snapshot.ref.path;

      const task = {
        httpRequest: {
          httpMethod: "POST" as const,
          url,
          body: Buffer.from(JSON.stringify(
              {docPath}
          )).toString("base64"),
          headers: {
            "Content-Type": "application/json",
          },
        },
        scheduleTime: {
          seconds: 300 + (Date.now() / 1000),
        },
      };

      const [response] = await tasksClient
          .createTask({parent: queuePath, task});

      const expirationTask = response.name;
      await snapshot.ref.update({"expiration_task": expirationTask});
    });

export const firestoreTtlCallback =
  functions.https.onRequest(async (req, res) => {
    const payload = req.body;
    try {
      await admin.firestore().doc(payload.docPath).update(
          {"status": "CAN", "expiration_task": null}
      );
      res.send(200);
    } catch (error) {
      console.error(error);
      res.status(500).send(error);
    }
  });

export const onUpdatePostCancelExpirationTask =
functions.firestore
    .document("reservation/{reservationId}")
    .onUpdate(async (change) => {
      const after = change.after.data();
      const expirationTask = after.expiration_task;
      const state = after.status;
      if ((state == "DEL") || (state == "CAN")) {
        if (state == "CAN") {
          const establishmentId = after.establishment_Id;
          const reservationDetailsSnapshot = await admin.firestore()
              .doc("reservation/"+change.after.id)
              .collection("reservation_Detail").get();

          reservationDetailsSnapshot.forEach( async (productDoc) => {
            const productDetail = productDoc.data();
            const productId = productDetail.product_Id;

            const productRef = admin.firestore()
                .collection("establishment")
                .doc(establishmentId)
                .collection("product")
                .doc(productId);

            const productSnapshot = await productRef.get();
            const product = productSnapshot.data();
            const stock = productDetail.quantity + product?.stock;

            await productRef.update({"stock": stock});
          });
        }
        if (expirationTask) {
          const taskClient = new CloudTasksClient();
          await taskClient.deleteTask({name: expirationTask});
        }
      }
    });
