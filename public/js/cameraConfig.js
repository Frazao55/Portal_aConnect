// Define aqui o deviceId da câmara externa, se quiseres forçar uma câmara específica.
// Também podes usar ?cameraDeviceId=... no URL ou localStorage.MIA_CAMERA_DEVICE_ID.
export const PREFERRED_CAMERA_DEVICE_ID = "eb5dbf942017d2ea672bc600f5aa234a63343dbb22b2daa16eb9abee0cd93807";

export function buildCameraConstraints() {
  const params = new URLSearchParams(window.location.search);
  const deviceId =
    params.get("cameraDeviceId") ||
    window.localStorage.getItem("MIA_CAMERA_DEVICE_ID") ||
    PREFERRED_CAMERA_DEVICE_ID;

  return {
    width: { ideal: 640 },
    height: { ideal: 480 },
    ...(deviceId
      ? { deviceId: { exact: deviceId } }
      : { facingMode: "user" })
  };
}
