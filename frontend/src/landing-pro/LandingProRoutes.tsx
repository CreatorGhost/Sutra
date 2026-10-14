// Public marketing routes for the scroll-choreographed 3D homepage set.
// Reachable signed-out, no app chrome. Hosts the gallery index + 5 variants.
import { lazy, Suspense } from "react";
import { Route, Routes } from "react-router-dom";
import "./pro.css";

const Gallery = lazy(() => import("./ProGallery"));
const V1 = lazy(() => import("./ProV1"));
const V2 = lazy(() => import("./ProV2"));
const V3 = lazy(() => import("./ProV3"));
const V4 = lazy(() => import("./ProV4"));
const V5 = lazy(() => import("./ProV5"));

export default function LandingProRoutes() {
  return (
    <Suspense fallback={<div className="pro-root" />}>
      <Routes>
        <Route path="/pro" element={<Gallery />} />
        <Route path="/pro/1" element={<V1 />} />
        <Route path="/pro/2" element={<V2 />} />
        <Route path="/pro/3" element={<V3 />} />
        <Route path="/pro/4" element={<V4 />} />
        <Route path="/pro/5" element={<V5 />} />
        <Route path="/pro/*" element={<Gallery />} />
      </Routes>
    </Suspense>
  );
}
