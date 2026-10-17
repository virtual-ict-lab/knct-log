import { ShieldAlert } from "lucide-react";

/** HTTP（localhost 以外）で開かれたとき。カメラもパスキーも暗号も使えないので先に進めない */
export function Insecure() {
  return (
    <div className="stack-center">
      <ShieldAlert size={48} />
      <p>HTTPS で開いてください</p>
      <p className="muted small">{location.origin}</p>
    </div>
  );
}
