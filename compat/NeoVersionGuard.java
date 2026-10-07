package dev.veyra.compat;

import java.lang.classfile.ClassFile;
import java.lang.classfile.CodeModel;
import java.lang.classfile.MethodModel;
import java.lang.classfile.Opcode;
import java.lang.classfile.instruction.ReturnInstruction;
import java.lang.constant.ClassDesc;
import java.lang.instrument.ClassFileTransformer;
import java.lang.instrument.Instrumentation;
import java.security.ProtectionDomain;

/**
 * Compatibility guard for NeoForge 26.3.0.56-beta.
 * The update checker returns null while pending; ClientHooks switches on it.
 * Only replaces a null result with FAILED, preserving every completed result.
 * Uses Java 25's classfile API. No game jars are changed on disk.
 */
public final class NeoVersionGuard {
    public static void premain(String arguments, Instrumentation instrumentation) {
        instrumentation.addTransformer(new ClassFileTransformer() {
            @Override
            public byte[] transform(ClassLoader loader, String name, Class<?> type,
                                    ProtectionDomain domain, byte[] bytes) {
                if (!"net/neoforged/neoforge/internal/NeoForgeVersionCheck".equals(name)) return null;
                var status = ClassDesc.of("net.neoforged.neoforge.common.VersionChecker$Status");
                var classFile = ClassFile.of();
                byte[] transformed = classFile.transformClass(classFile.parse(bytes), (builder, element) -> {
                    if (element instanceof MethodModel method && method.methodName().equalsString("getStatus")
                            && method.methodType().equalsString("()Lnet/neoforged/neoforge/common/VersionChecker$Status;")) {
                        builder.transformMethod(method, (methodBuilder, methodElement) -> {
                            if (methodElement instanceof CodeModel code) {
                                methodBuilder.transformCode(code, (codeBuilder, instruction) -> {
                                    if (instruction instanceof ReturnInstruction result && result.opcode() == Opcode.ARETURN) {
                                        var ready = codeBuilder.newLabel();
                                        codeBuilder.dup().ifnonnull(ready).pop()
                                                .getstatic(status, "FAILED", status)
                                                .labelBinding(ready).areturn();
                                    } else codeBuilder.with(instruction);
                                });
                            } else methodBuilder.with(methodElement);
                        });
                    } else builder.with(element);
                });
                System.out.println("[Veyra] NeoForge update-check null guard active.");
                return transformed;
            }
        });
    }
}
