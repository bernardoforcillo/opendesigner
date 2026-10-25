// Exported by opendesigner (opendesigner export): screen "Screen" (route /screen) of document "Test" (doc). DO NOT edit by hand:
// regenerate with `opendesigner export`. The data-node-id attribute ties every element to its design node.
package design.generated.screens

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.blur
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.dropShadow
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.*
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.scale
import androidx.compose.ui.graphics.shadow.Shadow
import androidx.compose.ui.graphics.vector.PathParser
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.CustomAccessibilityAction
import androidx.compose.ui.semantics.customActions
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.DpOffset
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import design.generated.R
import design.generated.components.*

@Composable
fun Screen(onNavigate: (String) -> Unit = {}, onBack: () -> Unit = {}) {
    // Screen (data-node-id="scr")
    Box(
        modifier = Modifier
            .size(400.dp, 300.dp)
            .background(Color(0xFFFFFFFF), RectangleShape)
    ) {
        // Card (data-node-id="card")
        Column(
            verticalArrangement = Arrangement.spacedBy(8.dp, Alignment.CenterVertically),
            horizontalAlignment = Alignment.Start,
            modifier = Modifier
                .offset(20.dp, 20.dp)
                .dropShadow(RectangleShape, Shadow(radius = 4.dp, color = Color(0xFF000000), offset = DpOffset(0.dp, 4.dp)))
                .size(300.dp, 120.dp)
                .clip(RectangleShape)
                .background(brush = Brush.linearGradient(0f to Color(0xFFE54D4D), 1f to Color(0xFF3366E5), start = Offset(0f, 0.001f), end = Offset(300f, 119.999f)), shape = RectangleShape)
                .padding(start = 16.dp, top = 12.dp, end = 16.dp, bottom = 12.dp)
        ) {
            // Title (data-node-id="title")
            Text(
                text = "Hello world",
                color = Color(0xFFFFFFFF),
                fontSize = 20.sp,
                fontWeight = FontWeight(700),
                modifier = Modifier
                    .width(200.dp)
                    .height(19.dp)
            )
            // Dot (data-node-id="dot")
            Box(
                modifier = Modifier
                    .size(24.dp, 24.dp)
                    .background(Color(0xFFE5E5E5), CircleShape)
            )
        }
        // Free (data-node-id="free")
        Box(
            modifier = Modifier
                .offset(40.dp, 180.dp)
                .size(100.dp, 50.dp)
                .background(Color(0xFFE54D4D), RoundedCornerShape(12.dp))
                .border(2.dp, Color(0xFF3366E5), RoundedCornerShape(12.dp))
        )
    }
}
