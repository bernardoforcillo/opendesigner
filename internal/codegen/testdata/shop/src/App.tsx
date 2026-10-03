// Esportato da opendesigner (opendesigner export): rotte dell'app del documento "Negozio" (shop). NON modificare a mano:
// rigenerare con `opendesigner export`. L'attributo data-node-id lega ogni elemento al nodo del design.
import { BrowserRouter, Route, Routes } from "react-router-dom";
import { Login } from "./screens/Login";
import { Home } from "./screens/Home";
import { Dettaglio } from "./screens/Dettaglio";

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        {/* schermata iniziale: montata anche su "/" */}
        <Route path="/" element={<Login />} />
        <Route path="/login" element={<Login />} />
        <Route path="/home" element={<Home />} />
        <Route path="/dettaglio" element={<Dettaglio />} />
      </Routes>
    </BrowserRouter>
  );
}
