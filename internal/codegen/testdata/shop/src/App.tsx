// Exported by opendesigner (opendesigner export): app routes of document "Shop" (shop). DO NOT edit by hand:
// regenerate with `opendesigner export`. The data-node-id attribute ties every element to its design node.
import { BrowserRouter, Route, Routes } from "react-router-dom";
import { Login } from "./screens/Login";
import { Home } from "./screens/Home";
import { Detail } from "./screens/Detail";

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        {/* start screen: also mounted on "/" */}
        <Route path="/" element={<Login />} />
        <Route path="/login" element={<Login />} />
        <Route path="/home" element={<Home />} />
        <Route path="/detail" element={<Detail />} />
      </Routes>
    </BrowserRouter>
  );
}
