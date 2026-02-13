// Import the functions you need from the SDKs you need
import { initializeApp } from "firebase/app";
import { getAnalytics } from "firebase/analytics";
// TODO: Add SDKs for Firebase products that you want to use
// https://firebase.google.com/docs/web/setup#available-libraries

// Your web app's Firebase configuration
// For Firebase JS SDK v7.20.0 and later, measurementId is optional
const firebaseConfig = {
  apiKey: "AIzaSyCxbA2_3BiBOjZryR5LOXCf_c2-Sgg7YSc",
  authDomain: "frontaliere-ticino.firebaseapp.com",
  projectId: "frontaliere-ticino",
  storageBucket: "frontaliere-ticino.firebasestorage.app",
  messagingSenderId: "957502085858",
  appId: "1:957502085858:web:4941e8997ebf75b0145cbb",
  measurementId: "G-G1E84HYGB7"
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);
const analytics = getAnalytics(app);

export { app, analytics };
