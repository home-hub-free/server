import { spanishNumber } from "./spanish-number";

describe("spanishNumber (0-100 -> Spanish words)", () => {
  it("renders zero", () => {
    expect(spanishNumber(0)).toBe("cero");
  });

  it("renders every 1-15 irregular", () => {
    expect(spanishNumber(1)).toBe("uno");
    expect(spanishNumber(2)).toBe("dos");
    expect(spanishNumber(3)).toBe("tres");
    expect(spanishNumber(4)).toBe("cuatro");
    expect(spanishNumber(5)).toBe("cinco");
    expect(spanishNumber(6)).toBe("seis");
    expect(spanishNumber(7)).toBe("siete");
    expect(spanishNumber(8)).toBe("ocho");
    expect(spanishNumber(9)).toBe("nueve");
    expect(spanishNumber(10)).toBe("diez");
    expect(spanishNumber(11)).toBe("once");
    expect(spanishNumber(12)).toBe("doce");
    expect(spanishNumber(13)).toBe("trece");
    expect(spanishNumber(14)).toBe("catorce");
    expect(spanishNumber(15)).toBe("quince");
  });

  it("renders the 16-19 dieci- compounds", () => {
    expect(spanishNumber(16)).toBe("dieciséis");
    expect(spanishNumber(17)).toBe("diecisiete");
    expect(spanishNumber(18)).toBe("dieciocho");
    expect(spanishNumber(19)).toBe("diecinueve");
  });

  it("renders 20 and the veinti- contracted compounds (21-29)", () => {
    expect(spanishNumber(20)).toBe("veinte");
    expect(spanishNumber(21)).toBe("veintiuno");
    expect(spanishNumber(22)).toBe("veintidós");
    expect(spanishNumber(23)).toBe("veintitrés");
    expect(spanishNumber(24)).toBe("veinticuatro");
    expect(spanishNumber(25)).toBe("veinticinco");
    expect(spanishNumber(26)).toBe("veintiséis");
    expect(spanishNumber(27)).toBe("veintisiete");
    expect(spanishNumber(28)).toBe("veintiocho");
    expect(spanishNumber(29)).toBe("veintinueve");
  });

  it("renders bare tens (30/40/50/60/70/80/90)", () => {
    expect(spanishNumber(30)).toBe("treinta");
    expect(spanishNumber(40)).toBe("cuarenta");
    expect(spanishNumber(50)).toBe("cincuenta");
    expect(spanishNumber(60)).toBe("sesenta");
    expect(spanishNumber(70)).toBe("setenta");
    expect(spanishNumber(80)).toBe("ochenta");
    expect(spanishNumber(90)).toBe("noventa");
  });

  it("renders uncontracted 'tens y unit' compounds (31-99, non-multiples of 10)", () => {
    expect(spanishNumber(31)).toBe("treinta y uno");
    expect(spanishNumber(45)).toBe("cuarenta y cinco"); // the plan's own worked example
    expect(spanishNumber(58)).toBe("cincuenta y ocho");
    expect(spanishNumber(99)).toBe("noventa y nueve");
  });

  it("renders one hundred as 'cien' (not 'ciento')", () => {
    expect(spanishNumber(100)).toBe("cien");
  });

  it("defensively rounds and clamps out-of-domain input instead of throwing", () => {
    expect(() => spanishNumber(-5)).not.toThrow();
    expect(spanishNumber(-5)).toBe("cero");
    expect(spanishNumber(150)).toBe("cien");
    expect(spanishNumber(45.6)).toBe("cuarenta y seis");
    expect(spanishNumber(NaN)).toBe("cero");
  });
});
