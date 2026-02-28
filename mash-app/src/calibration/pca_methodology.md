# PCA Functional Calibration Methodology

## Executive Summary

Functional Calibration is the industry-standard method for aligning Inertial Measurement Units (IMUs) to the biological skeleton. Unlike "Static Calibration" (T-Pose), which assumes perfect sensor placement, **Functional Calibration** mathematically discovers the joint axes by analyzing the user's actual movement.

Our system uses **Principal Component Analysis (PCA)** of angular velocity vectors to identify the dominant axis of rotation for hinge joints (knees, elbows) and **SARA (Symmetrical Axis of Rotation Analysis)** for more complex dual-segment optimization.

---

## 1. The Core Concept: Axis from Motion

Imagine a sensor taped to your thigh. You don’t know its orientation.
When you **flex your knee**, the thigh segment rotates around a specific 3D line in space—the **Knee Hinge Axis**.

*   If the sensor is perfectly aligned, the Gyroscope reads `[X, 0, 0]` (Pure X-axis rotation).
*   If the sensor is rotated 45°, the Gyroscope reads `[0.7, 0.7, 0]`.
*   If the sensor is arbitrary, the Gyroscope reads `[ω_x, ω_y, ω_z]`.

Crucially, **all angular velocity vectors lie along the same 3D line** (the hinge axis).

### Principal Component Analysis (PCA)
PCA is a statistical tool that finds the "principal directions" of a data cloud.
1.  We collect thousands of Gyroscope samples, forming a cloud of vectors in 3D space.
2.  For a hinge joint, this cloud looks like a **Line** (passing through origin).
3.  PCA calculates the **Eigenvectors** of the cloud covariance matrix.
    *   **1st Principal Component (PC1):** The direction of maximum variance. **THIS IS THE HINGE AXIS.**
    *   **Explained Variance Ratio:** A measure of confidence. If PC1 explains 95% of the data, it's a perfect hinge. If only 50%, the motion was messy (3D wobble).

---

## 2. Research Justification & Justification

This approach is not experimental; it is the foundation of clinical gait analysis using IMUs.

### Key Research Papers

> **"Functional alignment of the flexion/extension axis of the knee"**
> *Cutti et al., 2008 (Gait & Posture)*
> *   **Findings:** Functional calibration reduced kinematic crosstalk errors from **>20°** (using manual placement) to **<2°** (using functional methods).
> *   **Method:** Subjects flexed/extended knees. PCA identified the axis.

> **"Validation of a functional method for the estimation of the hip joint center"**
> *Camomilla et al., 2006*
> *   **Findings:** Functional methods outperformed regression models (predictive placement) by accounting for individual anatomical variations (obesity, bone deformity).

> **"SARA: Symmetrical Axis of Rotation Analysis"**
> *Ehrig et al., 2007 (J. Biomechanics)*
> *   **Method:** Solves for the hinge axis by minimizing the variation of the axis vector in both the parent AND child sensor frames simultaneously. Our `SARA` implementation is a direct application of this algorithm.

---

## 3. Practical Example: "The Thigh Fix"

Let's look at your specific case (`thigh_l`: 125° correction).

### Scenario
1.  **Placement:** You attach the sensor to the side of the thigh, but rotated 90° so the cable points "Back" instead of "Down".
2.  **Static Result:** The system thinks "Down" is "Cable Direction". It draws the leg pointing backwards.
3.  **The Movement (Auto-Walk):** You lift your knee (Flexion).
    *   **Biological Fact:** The thigh rotates around the **Lateral-Medial Axis** (Left/Right vector).
    *   **Sensor Reading:** The sensor sees rotation around its local **Z-axis** (because it's mounted sideways).
4.  **PCA Processing:**
    *   PCA analyzes the data. It sees a massive amount of rotation on the **Sensor Z-Axis**.
    *   It concludes: "The Functional Hinge Axis is the Sensor Z-Axis."
5.  **The Correction:**
    *   The Skeleton knows the **Biological Hinge** must be the **Bone X-Axis**.
    *   The Calibration Math calculates `q_correction` to map **Sensor Z** $\rightarrow$ **Bone X**.
    *   **Result:** This is a ~90° rotation correction.

When applied, the virtual leg snaps into alignment. Now, when the sensor rotates around Z, the virtual leg rotates around X. The "Backwards" cable placement is mathematically neutralized.

---

## 4. Why We Use "Gram-Schmidt" (The Secondary Axis)

PCA gives us **one** perfect axis (The Hinge). But we need a full 3D orientation (3 axes).
Rotating around the Hinge fixes Flexion, but technically the thigh could still spin around that hinge like a roasting chicken (axial rotation error).

To fix the other 2 axes, we use **Gravity** as a secondary constraint.
1.  **Primary Axis (X):** The PCA-derived Hinge Axis (100% trusted).
2.  **Secondary Guide (Y):** Gravity (Down).
3.  **Gram-Schmidt Orthogonalization:**
    *   Keep X perfect.
    *   Find the vector closest to Gravity that is *perpendicular* to X. Call that Y.
    *   Z is the cross product of X and Y.

This ensures the leg bends correctly AND points down correctly, fixing all 3 degrees of freedom.

---

## 5. Summary

**Functional PCA Calibration** says:
> *"I don't care how you put the sensor on. Show me how the joint moves, and I will define the sensor's coordinates based on that movement."*

This is robust, scientifically validated, and the only way to get clinical-grade data from consumer-grade placement.

---

## 6. SCoRE (Symmetrical Center of Rotation Estimation)

While PCA/SARA finds the **AXIS** (Vector), **SCoRE** finds the **Pivot Point** (X,Y,Z Coordinate).

### Why do we need it? (Auto-Scaling)
A standard 3D skeleton has generic proportions (e.g., femur length = 45cm). If the real user has a 50cm femur, the foot will "slide" on the floor because the virtual leg is too short to reach the ground.
To fix this, we need to measure the user's **actual bone lengths**.

### How SCoRE Works
SCoRE (**S**ymmetrical **C**enter **o**f **R**otation **E**stimation) finds the unique 3D point that remains stationary relative to **both** the parent and child segments during motion.

**Concept:**
1.  Imagine the Hip Joint. It is a ball-and-socket.
2.  The Pelvis sensor moves one way. The Thigh sensor moves another.
3.  There is only **one point in space** (the center of the femoral head) that does not move relative to the pelvis AND does not move relative to the femur.
4.  SCoRE solves a least-squares optimization problem to find this point $C$.

### The Math (simplified)
Given rotation matrices $R_{pelvis}(t)$ and $R_{thigh}(t)$, we solve for local vectors $c_{pelvis}$ and $c_{thigh}$ such that:
$$ R_{pelvis}(t) \cdot c_{pelvis} + d_{pelvis}(t) = R_{thigh}(t) \cdot c_{thigh} + d_{thigh}(t) \quad \forall t $$
*(Where d is translation, usually eliminated by differencing frames).*

### Research Foundation
> **"Assessment of the accuracy of a functional method for the estimation of the hip joint center"**
> *Ehrig et al., 2006 (J. Biomechanics)*
> *   **Findings:** SCoRE locates the hip center with an accuracy of **<2cm**, far superior to "predictive" methods (Bell, Harrington) utilized in optical motion capture which rely on pelvis width measurements.

### Application in Our Pipeline: "Auto-Scaling"
Once SCoRE runs on the Hip and Knee:
1.  It finds the **Hip Center** (Point A).
2.  It finds the **Knee Center** (Point B).
3.  The distance $\|A - B\|$ is the **Exat Femur Length** of the specific user.
4.  We automatically scale the virtual avatar's femur to match this length.

**Result:** The avatar's feet lock to the floor perfectly because the virtual skeleton now has the exact same dimensions as the physical user.
