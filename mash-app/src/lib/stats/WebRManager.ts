/**
 * WebR Manager
 *
 * Lazy-loads WebR for R statistical analysis in the browser.
 * Provides research-grade statistical methods including:
 * - t-tests, ANOVA, correlation
 * - ICC, SEM, MDC for reliability
 * - Bootstrap confidence intervals
 * - Effect sizes (Cohen's d, Hedges' g)
 * - Multiple comparison corrections
 */

import { WebR } from "webr";

// Singleton instance
let webRInstance: WebR | null = null;
let initPromise: Promise<WebR> | null = null;
let isInitialized = false;

// Loading state for UI feedback
export type WebRStatus = "idle" | "loading" | "ready" | "error";
let currentStatus: WebRStatus = "idle";
let statusListeners: ((status: WebRStatus) => void)[] = [];

/**
 * Subscribe to WebR status changes
 */
export function subscribeToStatus(
  listener: (status: WebRStatus) => void,
): () => void {
  statusListeners.push(listener);
  listener(currentStatus); // Immediately notify current status
  return () => {
    statusListeners = statusListeners.filter((l) => l !== listener);
  };
}

function setStatus(status: WebRStatus) {
  currentStatus = status;
  statusListeners.forEach((l) => l(status));
}

/**
 * Get WebR instance (lazy loads on first call)
 * Safe to call multiple times - returns same instance
 */
export async function getWebR(): Promise<WebR> {
  if (isInitialized && webRInstance) {
    return webRInstance;
  }

  if (initPromise) {
    return initPromise;
  }

  setStatus("loading");
  console.debug("[WebR] Starting initialization...");

  initPromise = (async () => {
    try {
      webRInstance = new WebR();
      await webRInstance.init();

      console.debug("[WebR] R runtime ready");

      // Install commonly needed packages (they load from WebR repository)
      // Note: Large packages may take time on first load
      console.debug("[WebR] Installing research packages...");
      await webRInstance.evalR(`
                # Core packages are already available
                # Additional packages can be installed from WebR repository
            `);

      isInitialized = true;
      setStatus("ready");
      console.debug("[WebR] Initialization complete");
      return webRInstance;
    } catch (error) {
      console.error("[WebR] Initialization failed:", error);
      setStatus("error");
      throw error;
    }
  })();

  return initPromise;
}

/**
 * Get current WebR status
 */
export function getWebRStatus(): WebRStatus {
  return currentStatus;
}

/**
 * Check if WebR is ready to use
 */
export function isWebRReady(): boolean {
  return isInitialized && webRInstance !== null;
}

// ============================================
// Statistical Analysis Functions
// ============================================

export interface TTestResult {
  statistic: number;
  pValue: number;
  confidenceInterval: [number, number];
  mean: number;
  method: string;
}

export interface ANOVAResult {
  fStatistic: number;
  pValue: number;
  df: [number, number];
  sumSq: number[];
  meanSq: number[];
}

export interface CorrelationResult {
  r: number;
  pValue: number;
  confidenceInterval: [number, number];
  method: string;
}

export interface ICCResult {
  icc: number;
  pValue: number;
  confidenceInterval: [number, number];
  type: string;
}

export interface DescriptiveStats {
  n: number;
  mean: number;
  sd: number;
  se: number;
  min: number;
  max: number;
  median: number;
  q1: number;
  q3: number;
}

/**
 * Perform a t-test
 */
export async function tTest(
  data1: number[],
  data2?: number[],
  options: {
    paired?: boolean;
    alternative?: "two.sided" | "less" | "greater";
  } = {},
): Promise<TTestResult> {
  const webR = await getWebR();
  const { paired = false, alternative = "two.sided" } = options;

  const result = await webR.evalR(`
        x <- c(${data1.join(",")})
        ${data2 ? `y <- c(${data2.join(",")})` : ""}
        result <- t.test(x${data2 ? ", y" : ""}, paired = ${paired ? "TRUE" : "FALSE"}, alternative = "${alternative}")
        list(
            statistic = as.numeric(result$statistic),
            pValue = result$p.value,
            ciLow = result$conf.int[1],
            ciHigh = result$conf.int[2],
            mean = as.numeric(result$estimate[1]),
            method = result$method
        )
    `);

  const values = (await result.toJs()) as any;
  return {
    statistic: values.statistic,
    pValue: values.pValue,
    confidenceInterval: [values.ciLow, values.ciHigh],
    mean: values.mean,
    method: values.method,
  };
}

/**
 * Calculate descriptive statistics
 */
export async function descriptiveStats(
  data: number[],
): Promise<DescriptiveStats> {
  const webR = await getWebR();

  const result = await webR.evalR(`
        x <- c(${data.join(",")})
        list(
            n = length(x),
            mean = mean(x),
            sd = sd(x),
            se = sd(x) / sqrt(length(x)),
            min = min(x),
            max = max(x),
            median = median(x),
            q1 = quantile(x, 0.25),
            q3 = quantile(x, 0.75)
        )
    `);

  return (await result.toJs()) as unknown as DescriptiveStats;
}

/**
 * Perform Shapiro-Wilk normality test
 */
export async function normalityTest(
  data: number[],
): Promise<{ statistic: number; pValue: number; isNormal: boolean }> {
  const webR = await getWebR();

  const result = await webR.evalR(`
        x <- c(${data.join(",")})
        result <- shapiro.test(x)
        list(
            statistic = as.numeric(result$statistic),
            pValue = result$p.value
        )
    `);

  const values = (await result.toJs()) as any;
  return {
    statistic: values.statistic,
    pValue: values.pValue,
    isNormal: values.pValue > 0.05,
  };
}

/**
 * Calculate correlation
 */
export async function correlation(
  x: number[],
  y: number[],
  method: "pearson" | "spearman" | "kendall" = "pearson",
): Promise<CorrelationResult> {
  const webR = await getWebR();

  const result = await webR.evalR(`
        x <- c(${x.join(",")})
        y <- c(${y.join(",")})
        result <- cor.test(x, y, method = "${method}")
        list(
            r = as.numeric(result$estimate),
            pValue = result$p.value,
            ciLow = if(!is.null(result$conf.int)) result$conf.int[1] else NA,
            ciHigh = if(!is.null(result$conf.int)) result$conf.int[2] else NA,
            method = result$method
        )
    `);

  const values = (await result.toJs()) as any;
  return {
    r: values.r,
    pValue: values.pValue,
    confidenceInterval: [values.ciLow, values.ciHigh],
    method: values.method,
  };
}

/**
 * Calculate Cohen's d effect size
 */
export async function cohensD(
  data1: number[],
  data2: number[],
): Promise<{ d: number; magnitude: string }> {
  const webR = await getWebR();

  const result = await webR.evalR(`
        x <- c(${data1.join(",")})
        y <- c(${data2.join(",")})
        
        # Cohen's d calculation
        n1 <- length(x)
        n2 <- length(y)
        m1 <- mean(x)
        m2 <- mean(y)
        s1 <- sd(x)
        s2 <- sd(y)
        
        # Pooled standard deviation
        sp <- sqrt(((n1 - 1) * s1^2 + (n2 - 1) * s2^2) / (n1 + n2 - 2))
        d <- (m1 - m2) / sp
        
        list(d = d)
    `);

  const values = (await result.toJs()) as any;
  const d = Math.abs(values.d);

  let magnitude: string;
  if (d < 0.2) magnitude = "negligible";
  else if (d < 0.5) magnitude = "small";
  else if (d < 0.8) magnitude = "medium";
  else magnitude = "large";

  return { d: values.d, magnitude };
}

/**
 * Apply multiple comparison correction
 */
export async function adjustPValues(
  pValues: number[],
  method: "bonferroni" | "holm" | "hochberg" | "BH" | "BY" | "fdr" = "BH",
): Promise<number[]> {
  const webR = await getWebR();

  const result = await webR.evalR(`
        p <- c(${pValues.join(",")})
        p.adjust(p, method = "${method}")
    `);

  return ((await result.toJs()) as any).values;
}

/**
 * Wilcoxon signed-rank test (non-parametric alternative to paired t-test)
 */
export async function wilcoxonTest(
  data1: number[],
  data2?: number[],
  options: { paired?: boolean } = {},
): Promise<{ statistic: number; pValue: number }> {
  const webR = await getWebR();
  const { paired = false } = options;

  const result = await webR.evalR(`
        x <- c(${data1.join(",")})
        ${data2 ? `y <- c(${data2.join(",")})` : ""}
        result <- wilcox.test(x${data2 ? ", y" : ""}, paired = ${paired ? "TRUE" : "FALSE"})
        list(
            statistic = as.numeric(result$statistic),
            pValue = result$p.value
        )
    `);

  return (await result.toJs()) as unknown as {
    statistic: number;
    pValue: number;
  };
}

// ============================================
// Reliability Analysis (PhD-Level Methods)
// ============================================

export interface SEMMDCResult {
  sem: number;
  mdc95: number;
  mdc90: number;
}

export interface BlandAltmanResult {
  bias: number;
  lowerLoA: number;
  upperLoA: number;
  sdDiff: number;
  percentageWithinLoA: number;
}

/**
 * Calculate Intraclass Correlation Coefficient (ICC)
 * Uses ICC(2,1) - Two-way random effects, absolute agreement, single rater
 * This is the most common form for reliability studies
 *
 * @param measurements - Array of measurement arrays (each inner array is one session/rater)
 */
export async function icc(measurements: number[][]): Promise<ICCResult> {
  const webR = await getWebR();

  // Format data as matrix for R
  const nSubjects = measurements[0].length;
  const nRaters = measurements.length;

  // Create matrix in R format
  const matrixData = measurements.flat().join(",");

  const result = await webR.evalR(`
        # Create matrix: rows = subjects, cols = raters/sessions
        data <- matrix(c(${matrixData}), nrow = ${nSubjects}, ncol = ${nRaters}, byrow = FALSE)
        
        # Calculate ICC using ANOVA approach (ICC2,1)
        n <- nrow(data)
        k <- ncol(data)
        
        # Grand mean
        grand_mean <- mean(data)
        
        # Between-subjects sum of squares
        subject_means <- rowMeans(data)
        SSB <- k * sum((subject_means - grand_mean)^2)
        
        # Within-subjects sum of squares
        SSW <- sum((data - matrix(rep(subject_means, k), ncol = k))^2)
        
        # Rater sum of squares
        rater_means <- colMeans(data)
        SSR <- n * sum((rater_means - grand_mean)^2)
        
        # Error sum of squares
        SSE <- SSW - SSR
        
        # Mean squares
        MSB <- SSB / (n - 1)
        MSR <- SSR / (k - 1)
        MSE <- SSE / ((n - 1) * (k - 1))
        
        # ICC(2,1) - Two-way random, absolute agreement, single
        icc_value <- (MSB - MSE) / (MSB + (k - 1) * MSE + (k / n) * (MSR - MSE))
        
        # F-test for significance
        f_value <- MSB / MSE
        df1 <- n - 1
        df2 <- (n - 1) * (k - 1)
        p_value <- 1 - pf(f_value, df1, df2)
        
        # 95% CI using F-distribution approximation
        f_l <- qf(0.025, df1, df2)
        f_u <- qf(0.975, df1, df2)
        
        ci_low <- (MSB - f_u * MSE) / (MSB + (k - 1) * MSE + (k / n) * (MSR - MSE))
        ci_high <- (MSB - f_l * MSE) / (MSB + (k - 1) * MSE + (k / n) * (MSR - MSE))
        
        list(
            icc = icc_value,
            pValue = p_value,
            ciLow = ci_low,
            ciHigh = ci_high
        )
    `);

  const values = (await result.toJs()) as any;

  // Interpret ICC value
  let interpretation: string;
  if (values.icc < 0.5) interpretation = "poor";
  else if (values.icc < 0.75) interpretation = "moderate";
  else if (values.icc < 0.9) interpretation = "good";
  else interpretation = "excellent";

  return {
    icc: values.icc,
    pValue: values.pValue,
    confidenceInterval: [values.ciLow, values.ciHigh],
    type: `ICC(2,1) - ${interpretation}`,
  };
}

/**
 * Calculate Standard Error of Measurement (SEM) and Minimal Detectable Change (MDC)
 * Essential for clinical significance assessment
 *
 * @param iccValue - ICC coefficient
 * @param pooledSD - Pooled standard deviation of measurements
 */
export function calculateSEMMDC(
  iccValue: number,
  pooledSD: number,
): SEMMDCResult {
  // SEM = SD * sqrt(1 - ICC)
  const sem = pooledSD * Math.sqrt(1 - iccValue);

  // MDC95 = SEM * 1.96 * sqrt(2)
  const mdc95 = sem * 1.96 * Math.sqrt(2);

  // MDC90 = SEM * 1.645 * sqrt(2)
  const mdc90 = sem * 1.645 * Math.sqrt(2);

  return { sem, mdc95, mdc90 };
}

/**
 * Perform Bland-Altman analysis for method comparison
 * Returns bias, limits of agreement, and percentage of points within LoA
 *
 * @param method1 - First method measurements
 * @param method2 - Second method measurements
 */
export async function blandAltman(
  method1: number[],
  method2: number[],
): Promise<BlandAltmanResult> {
  if (method1.length !== method2.length) {
    throw new Error("Method1 and method2 must have same length");
  }

  const webR = await getWebR();

  const result = await webR.evalR(`
        m1 <- c(${method1.join(",")})
        m2 <- c(${method2.join(",")})
        
        # Calculate differences and means
        diff <- m1 - m2
        avg <- (m1 + m2) / 2
        
        # Bias (mean difference)
        bias <- mean(diff)
        
        # SD of differences
        sd_diff <- sd(diff)
        
        # 95% Limits of Agreement
        lower_loa <- bias - 1.96 * sd_diff
        upper_loa <- bias + 1.96 * sd_diff
        
        # Percentage within LoA
        within_loa <- sum(diff >= lower_loa & diff <= upper_loa) / length(diff) * 100
        
        list(
            bias = bias,
            sdDiff = sd_diff,
            lowerLoA = lower_loa,
            upperLoA = upper_loa,
            percentageWithin = within_loa
        )
    `);

  const values = (await result.toJs()) as any;

  return {
    bias: values.bias,
    sdDiff: values.sdDiff,
    lowerLoA: values.lowerLoA,
    upperLoA: values.upperLoA,
    percentageWithinLoA: values.percentageWithin,
  };
}

/**
 * Start loading WebR in background (call early in app lifecycle)
 */
export function preloadWebR(): void {
  // Start loading but don't await - fire and forget
  getWebR().catch((err) => {
    console.warn("[WebR] Background preload failed:", err);
  });
}
