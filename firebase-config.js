import { initializeApp } from 'https://www.gstatic.com/firebasejs/12.10.0/firebase-app.js';
import { getFirestore } from 'https://www.gstatic.com/firebasejs/12.10.0/firebase-firestore.js';

const firebaseConfig = {
  apiKey: 'AIzaSyDmoE_ZoctX52hTGeUSt_yzp7_atdZZP6o',
  authDomain: 'mapa-alternativo.firebaseapp.com',
  projectId: 'mapa-alternativo',
  storageBucket: 'mapa-alternativo.firebasestorage.app',
  messagingSenderId: '822457260710',
  appId: '1:822457260710:web:c5d5972ec48d66f94bb267'
};

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

export { app, db };
