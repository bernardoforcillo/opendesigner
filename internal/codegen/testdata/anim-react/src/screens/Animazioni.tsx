// Esportato da opendesigner (opendesigner export): schermata "Animazioni" (rotta /) del documento "Animazioni" (anim). NON modificare a mano:
// rigenerare con `opendesigner export`. L'attributo data-node-id lega ogni elemento al nodo del design.
import { motion, type Variants } from "motion/react";

// clip "entrata" (enter), clip "evidenzia" (manual)
const cardVariants: Variants = {
  initial: { opacity: 0, y: -20 },
  animate: {
    opacity: [0, 1],
    y: [-20, 0],
    transition: {
      opacity: { duration: 0.8, delay: 0.1, ease: "easeOut" },
      y: { duration: 0.8, delay: 0.1, ease: [0.32, 0.66, 0.1, 1] },
    },
  },
  evidenzia: {
    opacity: [1, 0.5, 1],
    transition: {
      opacity: { duration: 0.3, times: [0, 0.5, 1], ease: "linear" },
    },
  },
};

// clip "entrata" (enter)
const titoloVariants: Variants = {
  initial: { scale: 0.8 },
  animate: {
    scale: [0.8, 1.1, 1],
    transition: {
      scale: { duration: 0.8, delay: 0.1, times: [0, 0.5, 1], ease: ["easeInOut", "linear"] },
    },
  },
};

// clip "disegna la firma" (enter)
const firmaTrattoVariants: Variants = {
  initial: { pathLength: 0 },
  animate: {
    pathLength: [0, 1],
    transition: {
      pathLength: { duration: 1.2, delay: 0.3, ease: [0.4, 0, 0.2, 1] },
    },
  },
};

// clip "hover" (hover), clip "pressione" (tap)
const pulsanteVariants: Variants = {
  hover: {
    scale: [1, 1.08],
    transition: {
      scale: { duration: 0.2, ease: "easeOut" },
    },
  },
  tap: {
    scale: [1, 0.95],
    transition: {
      scale: { duration: 0.1, ease: "linear" },
    },
  },
};

// clip "hover" (hover)
const etichettaVariants: Variants = {
  hover: {
    opacity: [1, 0.8],
    transition: {
      opacity: { duration: 0.2, ease: "linear" },
    },
  },
};

// clip "caricamento" (loop)
const caricamentoVariants: Variants = {
  initial: { rotate: 0 },
  animate: {
    rotate: [0, 180],
    transition: {
      rotate: { duration: 1, repeat: Infinity, repeatType: "reverse", ease: "linear" },
    },
  },
};

// clip "inclina" (hover)
const inclinatoVariants: Variants = {
  hover: {
    rotate: [0, 30],
    x: [0, 30],
    transition: {
      rotate: { duration: 0.3, ease: "easeOut" },
      x: { duration: 0.3, ease: "linear" },
    },
  },
};

export function Animazioni() {
  return (
    <motion.div
      data-node-id="scr"
      className="relative w-[400px] h-[420px] overflow-hidden bg-[#fff]"
      initial="initial"
      animate="animate"
    >
      <motion.div
        // clip manuale "evidenzia": per avviarla imposta animate="evidenzia" su questo elemento
        data-node-id="card"
        data-testid="card"
        className="absolute left-[20px] top-[20px] w-[360px] h-[100px] rounded-[12px] bg-[#3366f2]"
        variants={cardVariants}
      />
      <motion.div
        data-node-id="title"
        data-testid="title"
        className="absolute left-[36px] top-[40px] w-[300px] whitespace-pre-wrap break-words [font-family:Inter,_sans-serif] text-[24px] font-bold leading-[1.2] text-[#fff]"
        variants={titoloVariants}
      >
        {"Benvenuto"}
      </motion.div>
      <motion.div
        data-node-id="logo"
        className="absolute left-[20px] top-[140px] w-[120px] h-[60px]"
        initial="initial"
        animate="animate"
      >
        <svg
          data-node-id="sig"
          data-testid="sig"
          width="120"
          height="60"
          className="absolute left-0 top-0 w-[120px] h-[60px] overflow-visible max-w-none"
        >
          <motion.path
            d="M5 50C15 10 45 10 60 10C75 10 105 10 115 50"
            fill="none"
            stroke="#1a1a1f"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            variants={firmaTrattoVariants}
          />
        </svg>
      </motion.div>
      <motion.div
        data-node-id="btn"
        data-testid="btn"
        className="absolute left-[20px] top-[230px] w-[160px] h-[48px] flex justify-center items-center bg-[#3366f2]"
        variants={pulsanteVariants}
        style={{ scale: 1 }}
        whileHover="hover"
        whileTap="tap"
      >
        <motion.div
          data-node-id="btnLabel"
          data-testid="btn-label"
          className="relative shrink-0 w-[100px] whitespace-pre-wrap break-words h-[20px] [font-family:Inter,_sans-serif] text-[16px] font-semibold leading-[1.2] text-center text-[#fff]"
          variants={etichettaVariants}
          style={{ opacity: 1 }}
        >
          {"Premi"}
        </motion.div>
      </motion.div>
      <motion.div
        data-node-id="spin"
        data-testid="spin"
        className="absolute left-[300px] top-[230px] w-[48px] h-[48px] rounded-[50%] bg-[#e54d4d]"
        variants={caricamentoVariants}
        initial="initial"
        animate="animate"
      />
      <motion.div
        data-node-id="tilt"
        data-testid="tilt"
        className="absolute left-[200px] top-[330px] w-[60px] h-[30px] rotate-[30deg] bg-[#4db266]"
        variants={inclinatoVariants}
        style={{ rotate: 0, x: 0 }}
        whileHover="hover"
      />
    </motion.div>
  );
}
