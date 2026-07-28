import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SiteHeader } from "../components/site-header";

describe("SiteHeader", () => {
  it("exposes the primary developer navigation", () => {
    render(<SiteHeader />);
    expect(screen.getByRole("link", { name: "Cashu Fault Lab" })).toHaveAttribute("href", "/");
    expect(screen.getByRole("link", { name: "Docs" })).toHaveAttribute(
      "href",
      "/docs/getting-started",
    );
    expect(screen.getByRole("link", { name: "Scenarios" })).toHaveAttribute(
      "href",
      "/scenarios",
    );
    expect(screen.getByRole("link", { name: "Release status" })).toHaveAttribute(
      "href",
      "/release-status",
    );
  });
});
