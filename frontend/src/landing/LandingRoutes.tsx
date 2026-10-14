// Public marketing routes — rendered by App BEFORE the onboarding/auth gates, so
// /landing/* is reachable signed-out and carries no app chrome (Header/Nav). Hosts the
// gallery index plus the 5 homepage variants for review.
import { lazy, Suspense } from "react";
import { Route, Routes } from "react-router-dom";
import "./landing.css";

const Gallery = lazy(() => import("./LandingGallery"));
const V1 = lazy(() => import("./LandingV1"));
const V2 = lazy(() => import("./LandingV2"));
const V3 = lazy(() => import("./LandingV3"));
const V4 = lazy(() => import("./LandingV4"));
const V5 = lazy(() => import("./LandingV5"));

export default function LandingRoutes() {
  return (
    <Suspense fallback={<div className="landing-root" />}>
      <Routes>
        <Route path="/landing" element={<Gallery />} />
        <Route path="/landing/1" element={<V1 />} />
        <Route path="/landing/2" element={<V2 />} />
        <Route path="/landing/3" element={<V3 />} />
        <Route path="/landing/4" element={<V4 />} />
        <Route path="/landing/5" element={<V5 />} />
        <Route path="/landing/*" element={<Gallery />} />
      </Routes>
    </Suspense>
  );
}
