import type { ImgHTMLAttributes } from "react";

export default function ImageFixture(props: ImgHTMLAttributes<HTMLImageElement> & { unoptimized?: boolean }) {
  const { unoptimized, ...imageProps } = props;
  void unoptimized;
  return <img {...imageProps} />;
}
